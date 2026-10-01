// One Codex / Hermes thread = at most one ACP agent process + session (plan 2.3, 2.6, 2.7, 2.11, 2.15).
// States: closed -> starting -> ready <-> prompting, closing. Turns are serialized like ThreadRunner (`work`).
// The session id lives on the thread (`thread.acp.sessionId`); a new process `session/load`s it.
import { randomUUID } from 'node:crypto';
import { RequestError, type ContentBlock, type RequestPermissionResponse, type SessionNotification } from '@agentclientprotocol/sdk';
import { finalizeAcpTurn, initialAcpReducerState, MAX_LABEL_CHARS, reduceAcpUpdate } from '../../core/acpReducer';
import type { AcpAgentKind, AcpReducerState, AcpSignal, AcpStopReason } from '../../core/acpTypes';
import { CODEX_MODE_BY_PERMISSION, isCodexAutoReviewMode, isFullAccessMode, reconcileConfig } from '../../core/agentDefaults';
import { redact } from '../../core/redact';
import { AGENTS } from '../../shared/agents';
import {
  ACP_CANCEL_GRACE_MS,
  ACP_CONTROL_TIMEOUT_MS,
  ACP_INITIALIZE_TIMEOUT_MS,
  ACP_SESSION_OPEN_TIMEOUT_MS,
  CODEX_EFFORT_LEVELS,
  MINUTE_MS,
} from '../../shared/constants';
import type {
  AcpConfigOptionLite,
  AcpControls,
  AcpModeLite,
  ChatEvent,
  ChatImage,
  ChatItem,
  ChatSendResult,
  CodexEffortLevel,
  EffortLevel,
  SystemNoticeItem,
  Thread,
  ThreadAcpState,
  TurnEndReason,
  UiPermissionMode,
} from '../../shared/types';
import {
  AcpAbortedError,
  AcpConnection,
  AcpProcessExitedError,
  AcpProtocolVersionError,
  AcpSpawnError,
  AcpTimeoutError,
  type AcpConnectionOptions,
} from '../acp/acpConnection';
import type { AcpLauncher, AcpLaunchSpec, AgentRunner, Broadcaster, ModelInfoLite, Store, ThreadLog } from '../contracts';
import type { PermissionBroker } from './permissionBroker';

/** Consecutive failed session opens after which the thread shows `error` instead of `idle`. */
const MAX_OPEN_FAILURES = 3;
/** Hermes' non-standard `models.currentModelId` label cap. */
const REPORTED_MODEL_MAX = 120;
/** Session modes kept from an open response. */
const MAX_MODES = 200;

export interface AcpRunnerTimeouts {
  initialize: number;
  open: number;
  control: number;
  cancelGrace: number;
}

export interface AcpRunnerDeps {
  agent: AcpAgentKind;
  launcher: AcpLauncher;
  store: Pick<Store, 'get' | 'getThread' | 'patchThread'>;
  threadLog: Pick<ThreadLog, 'append'>;
  broadcaster: Broadcaster;
  broker: Pick<PermissionBroker, 'requestAcp' | 'cancelThread'>;
  appVersion: string;
  /** Scratch root: threads without a project get GIT_CEILING_DIRECTORIES=<root> (plan 2.12). */
  scratchRoot?: string;
  /** The agent could not start or reported missing auth: re-detect its local login (LocalAuthService.recheck). */
  onAgentProblem?: (agent: AcpAgentKind) => void;
  /** A turn ended (agent usage refresh). */
  onTurnEnd?: (agent: AcpAgentKind) => void;
  /** Connection factory (tests inject spawn / killGroup through it). */
  connect?: (opts: AcpConnectionOptions) => AcpConnection;
  timeouts?: Partial<AcpRunnerTimeouts>;
  now: () => number;
  log: (message: string, err?: unknown) => void;
}

type RunnerState = 'closed' | 'starting' | 'ready' | 'prompting' | 'closing';

const EMPTY_CONTROLS: AcpControls = { modes: [], currentModeId: null, configOptions: [], reportedModel: null };

export class AcpRunner implements AgentRunner {
  readonly agent: AcpAgentKind;
  private state: RunnerState = 'closed';
  private conn: AcpConnection | null = null;
  /** Session id of the live connection. */
  private sessionId: string | null = null;
  /** Aborts initialize / new / load of the connection being opened. */
  private openAbort: AbortController | null = null;
  /** Item id namespace of the live connection (reducer ids restart per connection). */
  private tag = '';
  private reducer: AcpReducerState;
  private turnNo = 0;
  /** Non-null while `session/load` replays history (updates are dropped, only controls are kept). */
  private replay: { count: number } | null = null;
  private busy = false;
  /** Stop pressed for the current turn. */
  private interrupted = false;
  /** Retired (thread deleted / app quit). */
  private retired = false;
  /** Permission mode changed without a matching ACP mode: respawn (new `INITIAL_AGENT_MODE`) before the next turn. */
  private respawnNeeded = false;
  private openFailures = 0;
  /** Thread permission the last resolved launch spec was built with (Codex `INITIAL_AGENT_MODE`). */
  private specPermission: UiPermissionMode | null = null;
  /** The last `session/load` (or resume) timed out: the next open goes straight to `session/new`. */
  private skipLoad = false;
  /** Mode the app itself chose (Hermes chip / open baseline): an agent-side switch to it is not reverted. */
  private approvedModeId: string | null = null;
  /** Serializes turns and connection closes (idle / respawn close finish before the next turn starts). */
  private work: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  /** Connections closing in the background (abort() kills them on the quit timeout). */
  private readonly closing = new Set<AcpConnection>();
  private readonly timeouts: AcpRunnerTimeouts;

  constructor(
    readonly threadId: string,
    private readonly deps: AcpRunnerDeps,
  ) {
    this.agent = deps.agent;
    this.reducer = initialAcpReducerState(threadId, 0);
    this.timeouts = {
      initialize: ACP_INITIALIZE_TIMEOUT_MS,
      open: ACP_SESSION_OPEN_TIMEOUT_MS,
      control: ACP_CONTROL_TIMEOUT_MS,
      cancelGrace: ACP_CANCEL_GRACE_MS,
      ...deps.timeouts,
    };
  }

  // -------------------------------------------------------------------------
  // AgentRunner
  // -------------------------------------------------------------------------

  async send(text: string, images: ChatImage[] = []): Promise<ChatSendResult> {
    if (this.retired) return { accepted: false, reason: 'busy' };
    const thread = this.thread();
    if (this.busy || thread.status === 'running') return { accepted: false, reason: 'busy' };
    // Busy while the launcher resolves (it may wait for an engine detection in progress).
    this.busy = true;
    const spec = await this.resolveSpec(thread).catch((err: unknown) => {
      this.deps.log('[acp] launcher failed', err);
      return null;
    });
    if (this.retired || !spec) {
      this.busy = false;
      return this.retired ? { accepted: false, reason: 'busy' } : { accepted: false, reason: 'agent-unavailable' };
    }

    this.interrupted = false;
    this.clearIdleTimer();
    const attached = images.length > 0 ? { images } : {};
    this.emitItem({ type: 'user', id: newId('user'), text, createdAt: this.deps.now(), ...attached });
    this.patch({ status: 'running', ...(thread.sessionStartedAt === null ? { sessionStartedAt: this.deps.now() } : {}) });
    this.emitEvent({ type: 'turn-start' });
    this.enqueue(() =>
      this.runTurn(text, images, spec).catch((err: unknown) => {
        this.busy = false;
        if (this.retired) return;
        this.deps.log('[acp] turn failed', err);
        this.safePatch({ status: 'idle' });
      }),
    );
    return { accepted: true };
  }

  /** Stop: `starting` aborts the open and kills the process; `prompting` sends session/cancel (kill after grace). */
  async interrupt(): Promise<void> {
    if (!this.busy) return;
    this.interrupted = true;
    this.deps.broker.cancelThread(this.threadId);
    if (this.state === 'starting') {
      this.openAbort?.abort();
      this.conn?.kill();
      return;
    }
    const conn = this.conn;
    if (this.state !== 'prompting' || !conn || !this.sessionId) return;
    conn.notify('session/cancel', { sessionId: this.sessionId });
    if (this.cancelTimer) return;
    this.cancelTimer = setTimeout(() => {
      this.cancelTimer = null;
      // The agent ignored the cancel: kill it; the session id stays and the next send loads it.
      if (this.conn === conn && this.state === 'prompting') conn.kill();
    }, this.timeouts.cancelGrace);
  }

  async resumeWaiting(): Promise<void> {
    // ACP threads never wait for rate limits.
  }

  async setModel(model: string): Promise<void> {
    this.patch({ model });
  }

  async setEffort(effort: Thread['effort']): Promise<void> {
    this.patch({ effort });
  }

  /**
   * Codex (plan 2.15): the app permission chip. Live session -> `session/set_mode` to the matching mode; no match or
   * a failure -> the process is restarted with a new launch env before the next turn (and loads the session).
   * Hermes has no permission chip: the value is only stored.
   */
  async setPermissionMode(mode: UiPermissionMode): Promise<void> {
    this.patch({ permissionMode: mode });
    if (this.agent !== 'codex') return;
    const conn = this.liveConn();
    if (!conn || !this.sessionId) {
      // Opening (applyAfterOpen re-checks), closing or a queued turn: the next open must use the new mode.
      if (this.busy || this.state === 'starting' || this.state === 'closing') this.respawnNeeded = true;
      return;
    }
    const controls = this.controls();
    const modeId = codexModeFor(mode, controls.modes);
    if (modeId) {
      if (modeId === controls.currentModeId) return;
      try {
        await conn.request('session/set_mode', { sessionId: this.sessionId, modeId }, this.timeouts.control);
        this.updateControls({ currentModeId: modeId });
        return;
      } catch (err) {
        this.deps.log('[acp] set_mode for permission failed', errName(err));
      }
    }
    if (this.busy) this.respawnNeeded = true;
    else this.enqueue(() => this.closeConnection({}).catch((err: unknown) => this.deps.log('[acp] respawn close failed', err)));
  }

  /** The agent already switched (Claude allow-session suggestion path): ACP mirrors the store only. */
  applySessionPermissionMode(mode: UiPermissionMode): void {
    if (this.retired || this.deps.store.getThread(this.threadId)?.permissionMode === mode) return;
    this.patch({ permissionMode: mode });
  }

  /** Hermes mode chip: `session/set_mode` now, or remembered until the next session opens. */
  async setAgentMode(modeId: string): Promise<void> {
    this.approvedModeId = modeId;
    const conn = this.liveConn();
    if (!conn || !this.sessionId) {
      this.patchAcp({ pendingModeId: modeId });
      return;
    }
    await conn.request('session/set_mode', { sessionId: this.sessionId, modeId }, this.timeouts.control);
    this.patchAcp({ pendingModeId: null });
    this.updateControls({ currentModeId: modeId });
  }

  /** Composer model / effort / agent options: `session/set_config_option`, or stored for the next spawn. */
  async setAgentConfig(configId: string, value: string | boolean): Promise<void> {
    const conn = this.liveConn();
    if (!conn || !this.sessionId) {
      const options = this.controls().configOptions.map((o) => withCurrentValue(o, configId, value));
      this.updateControls({ configOptions: options });
      this.syncThreadConfig(options);
      return;
    }
    const params =
      typeof value === 'boolean'
        ? { sessionId: this.sessionId, configId, type: 'boolean' as const, value }
        : { sessionId: this.sessionId, configId, value };
    const res = await conn.request('session/set_config_option', params, this.timeouts.control);
    const reported = liteConfigOptions(this.threadId, (res as { configOptions?: unknown }).configOptions);
    // Hermes answers `configOptions: []`: keep what we had, with the accepted value.
    const options =
      reported.length > 0 ? reported : this.controls().configOptions.map((o) => withCurrentValue(o, configId, value));
    this.updateControls({ configOptions: options });
    this.syncThreadConfig(options);
  }

  async releaseAccount(): Promise<void> {
    // ACP threads use the agent's own login, not the Claude account pool.
  }

  supportedModels(): Promise<ModelInfoLite[]> | null {
    return null;
  }

  /** Quit timeout: kill every process of this runner now. */
  abort(): void {
    this.retired = true;
    this.clearIdleTimer();
    this.clearCancelTimer();
    this.openAbort?.abort();
    this.conn?.kill();
    for (const c of this.closing) c.kill();
  }

  /**
   * Retire the runner (thread deleted / app quit); resolves after the agent process exited.
   * `dispose` (app quit): skip `session/close`, at most ACP_DISPOSE_BUDGET_MS.
   */
  async close(opts: { dispose?: boolean } = {}): Promise<void> {
    this.retired = true;
    this.clearIdleTimer();
    this.clearCancelTimer();
    this.openAbort?.abort();
    if (this.state === 'prompting' && this.conn && this.sessionId && !opts.dispose) {
      this.conn.notify('session/cancel', { sessionId: this.sessionId });
    }
    this.deps.broker.cancelThread(this.threadId);
    await this.closeConnection(opts);
    await Promise.all([...this.closing].map((c) => c.exited));
  }

  async whenSettled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.work;
      await current;
    } while (current !== this.work);
  }

  // -------------------------------------------------------------------------
  // Turn
  // -------------------------------------------------------------------------

  private async runTurn(text: string, images: ChatImage[], spec: AcpLaunchSpec): Promise<void> {
    if (this.retired) {
      this.busy = false;
      return;
    }
    if (this.interrupted) {
      // Stopped while queued behind a close.
      this.endTurn('interrupted');
      return;
    }
    try {
      for (let attempt = 0; ; attempt++) {
        if (this.respawnNeeded || (this.conn && this.conn.isGone)) {
          this.respawnNeeded = false;
          await this.closeConnection({});
          // Never fall back to the previous spec: the launcher re-verifies the engine, and a refusal must stop
          // the turn rather than respawn the old CODEX_PATH.
          const next = await this.resolveSpec(this.thread());
          if (!next) {
            this.reportError(`${this.label()}을(를) 다시 시작할 수 없습니다. 설치·로그인 상태를 확인해 주세요.`);
            this.endTurn('error');
            return;
          }
          spec = next;
        }
        // Closed / retired while the old connection was closing: never spawn an orphan.
        if (this.retired) {
          this.busy = false;
          return;
        }
        if (!this.conn) await this.ensureSession(spec);
        // The open could not switch to the thread's (changed) permission: one respawn with a new launch env.
        if (!this.respawnNeeded || attempt >= 1 || this.retired || this.interrupted) break;
      }
    } catch (err) {
      this.endOpenFailed(err);
      return;
    }
    if (this.retired) {
      this.busy = false;
      return;
    }
    if (this.interrupted) {
      this.endTurn('interrupted');
      return;
    }
    // Still not on the thread's permission after the retry: never prompt under the old sandbox / approval policy.
    if (this.respawnNeeded) {
      this.reportError(`${this.label()}에 바뀐 권한 설정을 적용하지 못해 메시지를 보내지 않았습니다. 다시 보내 주세요.`);
      this.endTurn('error');
      return;
    }

    const conn = this.conn!;
    const sessionId = this.sessionId!;
    this.turnNo += 1;
    // Chunks the agent sent between turns are confirmed (and persisted) before the reducer starts over.
    const settledTools = this.flushReducer();
    this.reducer = { ...initialAcpReducerState(this.threadId, this.turnNo), settledTools };
    const prompt: ContentBlock[] = [];
    if (images.length > 0) {
      if (conn.init?.agentCapabilities?.promptCapabilities?.image) {
        for (const img of images) prompt.push({ type: 'image', mimeType: img.mediaType, data: img.data });
      } else {
        this.notice('warn', `${this.label()}은(는) 이미지 입력을 지원하지 않아 이미지를 제외하고 보냈습니다.`);
      }
    }
    prompt.push({ type: 'text', text });

    this.state = 'prompting';
    let stopReason: AcpStopReason | 'error' = 'error';
    let failure: unknown = null;
    try {
      const res = await conn.request('session/prompt', { sessionId, prompt }, null);
      stopReason = res.stopReason;
    } catch (err) {
      failure = err;
    } finally {
      this.clearCancelTimer();
    }
    const fin = finalizeAcpTurn(this.reducer, this.interrupted ? 'cancelled' : stopReason, this.deps.now());
    this.reducer = fin.state;
    if (!this.retired) this.emitReduced(fin.events);
    if (this.conn === conn) this.state = conn.isGone ? 'closed' : 'ready';
    if (this.retired) {
      this.busy = false;
      return;
    }

    if (failure !== null) {
      if (failure instanceof AcpProcessExitedError || conn.isGone) {
        // Crash / kill: drop the connection (and clear its process group); the session id stays for the next load.
        conn.kill();
        this.dropConnection(conn);
        if (this.interrupted) {
          this.endTurn('interrupted');
        } else {
          this.reportError(this.exitMessage(failure, conn));
          this.endTurn('error');
        }
        return;
      }
      if (this.interrupted) {
        this.endTurn('interrupted');
        return;
      }
      if (isAuthError(failure)) {
        this.deps.onAgentProblem?.(this.agent);
        this.notice('error', this.authMessage());
        this.endTurn('auth');
        return;
      }
      this.reportError(`${this.label()} 오류: ${redact(errText(failure))}`);
      this.endTurn('error');
      return;
    }

    // Stop pressed: interrupted whatever the agent answered (end_turn after a late cancel, too).
    if (this.interrupted || stopReason === 'cancelled') {
      this.endTurn('interrupted');
      return;
    }
    if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      this.notice('warn', `${this.label()}이(가) 한도(${stopReason})에 도달해 응답을 멈췄습니다.`);
    } else if (stopReason === 'refusal') {
      this.notice('warn', '에이전트가 요청을 거절했습니다.');
    }
    this.endTurn(undefined);
  }

  private endTurn(reason: TurnEndReason | undefined): void {
    this.busy = false;
    this.interrupted = false;
    this.emitEvent({ type: 'turn-end', ok: reason === undefined, ...(reason ? { reason } : {}) });
    this.safePatch({ status: 'idle' });
    if (!this.retired) {
      this.scheduleIdleClose();
      this.deps.onTurnEnd?.(this.agent);
    }
  }

  /** ensureSession failed (the connection is already killed and dropped). */
  private endOpenFailed(err: unknown): void {
    this.busy = false;
    if (this.retired) return;
    if (this.interrupted || err instanceof AcpAbortedError) {
      this.interrupted = false;
      this.emitEvent({ type: 'turn-end', ok: false, reason: 'interrupted' });
      this.safePatch({ status: 'idle' });
      return;
    }
    this.openFailures += 1;
    let reason: TurnEndReason = 'error';
    if (isAuthError(err)) {
      reason = 'auth';
      this.deps.onAgentProblem?.(this.agent);
      this.notice('error', this.authMessage());
    } else {
      if (err instanceof AcpSpawnError) this.deps.onAgentProblem?.(this.agent);
      this.reportError(this.openErrorMessage(err));
    }
    this.emitEvent({ type: 'turn-end', ok: false, reason });
    this.safePatch({ status: this.openFailures >= MAX_OPEN_FAILURES ? 'error' : 'idle' });
  }

  // -------------------------------------------------------------------------
  // Session open (plan 2.6)
  // -------------------------------------------------------------------------

  private async ensureSession(spec: AcpLaunchSpec): Promise<void> {
    const thread = this.thread();
    const spawnedWith = this.specPermission;
    const abort = new AbortController();
    this.openAbort = abort;
    this.state = 'starting';
    const conn = this.openConnection(spec, thread.cwd);
    this.conn = conn;
    try {
      if (this.retired) throw new AcpAbortedError('session open');
      const init = await conn.initialize(abort.signal, this.timeouts.initialize);
      const caps = init.agentCapabilities ?? {};
      const prevId = thread.acp?.sessionId ?? null;
      const open = { cwd: thread.cwd, mcpServers: [] };
      let opened: { sessionId: string; res: unknown } | null = null;

      const skippedLoad = this.skipLoad;
      if (prevId && caps.loadSession && !skippedLoad) {
        const replay = { count: 0 };
        this.replay = replay;
        try {
          const res = await conn.request('session/load', { sessionId: prevId, ...open }, this.timeouts.open, abort.signal);
          // The SDK turns a `null` (not found) into `{}`: `modes` is the main signal, replayed updates the second.
          const hasModes = isRecord(res) && res.modes !== undefined && res.modes !== null;
          if (hasModes || replay.count > 0) {
            if (!hasModes) this.deps.log('[acp] session/load without modes but with replay; treated as loaded');
            opened = { sessionId: prevId, res };
          }
        } catch (err) {
          // A load that hangs would hang every retry: the next open starts a new session instead.
          if (err instanceof AcpTimeoutError) this.skipLoad = true;
          if (!isFallbackError(err)) throw err;
          this.deps.log('[acp] session/load failed; starting a new session', errName(err));
        } finally {
          this.replay = null;
        }
      } else if (prevId && caps.sessionCapabilities?.resume && !skippedLoad) {
        // Only agents without load: Hermes' resume silently creates a missing session.
        try {
          const res = await conn.request('session/resume', { sessionId: prevId, ...open }, this.timeouts.open, abort.signal);
          opened = { sessionId: prevId, res };
        } catch (err) {
          if (err instanceof AcpTimeoutError) this.skipLoad = true;
          if (!isFallbackError(err)) throw err;
          this.deps.log('[acp] session/resume failed; starting a new session', errName(err));
        }
      }

      if (!opened) {
        const res = await conn.request('session/new', open, this.timeouts.open, abort.signal);
        opened = { sessionId: res.sessionId, res };
        if (prevId) {
          this.notice(
            'info',
            skippedLoad
              ? `이전 ${this.label()} 세션을 불러오는 데 시간이 초과되어 새 세션으로 시작했습니다. 화면의 이전 대화는 에이전트 컨텍스트에 포함되지 않습니다.`
              : `이전 ${this.label()} 세션을 이어갈 수 없어 새 세션으로 시작했습니다. 화면의 이전 대화는 에이전트 컨텍스트에 포함되지 않습니다.`,
          );
        }
      }
      if (abort.signal.aborted || conn.isGone) throw new AcpAbortedError('session open');

      this.skipLoad = false;
      this.sessionId = opened.sessionId;
      // Anything the previous connection's reducer still held is confirmed under its own id namespace first.
      this.flushReducer();
      this.reducer = initialAcpReducerState(this.threadId, this.turnNo);
      this.tag = randomUUID().slice(0, 8);
      // Slash commands come in a notification (possibly before this response); the last list stays until replaced.
      const knownCommands = this.controls().commands;
      const controls: AcpControls = { ...controlsFrom(this.threadId, opened.res), ...(knownCommands ? { commands: knownCommands } : {}) };
      this.patchAcp({ sessionId: opened.sessionId, controls });
      this.broadcastControls(controls);
      await this.applyAfterOpen(conn, abort.signal, spawnedWith);
      await this.leaveUnapprovedFullAccess(conn, abort.signal);
      // Retired (close / quit) while opening: the catch kills the process.
      if (this.retired || abort.signal.aborted || conn.isGone) throw new AcpAbortedError('session open');
      this.state = 'ready';
      this.openFailures = 0;
    } catch (err) {
      this.replay = null;
      conn.kill();
      this.dropConnection(conn);
      throw err;
    } finally {
      if (this.openAbort === abort) this.openAbort = null;
    }
  }

  /** Pending Hermes mode, then Codex model / effort reconciliation (plan 2.11 step 2). */
  private async applyAfterOpen(conn: AcpConnection, signal: AbortSignal, spawnedWith: UiPermissionMode | null): Promise<void> {
    const sessionId = this.sessionId!;
    const pendingModeId = this.thread().acp?.pendingModeId ?? null;
    if (pendingModeId) {
      this.approvedModeId = pendingModeId;
      try {
        await conn.request('session/set_mode', { sessionId, modeId: pendingModeId }, this.timeouts.control, signal);
        this.updateControls({ currentModeId: pendingModeId });
      } catch (err) {
        if (err instanceof AcpAbortedError || err instanceof AcpProcessExitedError) throw err;
        this.deps.log('[acp] pending set_mode failed', errName(err));
      }
      this.patchAcp({ pendingModeId: null });
    }
    if (this.agent !== 'codex') return;

    const thread = this.thread();
    const plan = reconcileConfig(this.controls().configOptions, { model: thread.model || null, effort: thread.effort });
    for (const set of plan.set) {
      try {
        const res = await conn.request(
          'session/set_config_option',
          { sessionId, configId: set.configId, value: set.value },
          this.timeouts.control,
          signal,
        );
        const options = liteConfigOptions(this.threadId, (res as { configOptions?: unknown }).configOptions);
        this.updateControls({
          configOptions:
            options.length > 0
              ? options
              : this.controls().configOptions.map((o) => withCurrentValue(o, set.configId, set.value)),
        });
      } catch (err) {
        if (err instanceof AcpAbortedError || err instanceof AcpProcessExitedError) throw err;
        this.deps.log('[acp] set_config_option after open failed', errName(err));
      }
    }
    for (const miss of plan.missing) {
      const what = miss.category === 'model' ? '모델' : 'reasoning effort';
      this.notice('warn', `${this.label()}가 ${what} ${miss.wanted}을(를) 제공하지 않아 ${miss.current ?? '기본값'}(으)로 실행합니다.`);
    }
    // Thread values follow what the session really runs with (also covers the `missing` adoption).
    this.syncThreadConfig(this.controls().configOptions);
    await this.reconcilePermission(conn, signal, spawnedWith);
  }

  /**
   * The session opened (or was loaded) in a full-access-like mode the app never confirmed: switch back before any
   * prompt. A failure fails the open (the process is killed), so no turn runs in that mode.
   */
  private async leaveUnapprovedFullAccess(conn: AcpConnection, signal: AbortSignal): Promise<void> {
    const { modes, currentModeId } = this.controls();
    const mode = modes.find((m) => m.id === currentModeId);
    if (!mode || !this.isEscalatedMode(mode) || this.isApprovedFullAccess(mode)) return;
    const target = this.safeModeTarget(null);
    if (!target) throw new Error(`cannot leave the unconfirmed mode ${mode.id}`);
    await conn.request('session/set_mode', { sessionId: this.sessionId!, modeId: target }, this.timeouts.control, signal);
    this.updateControls({ currentModeId: target });
    this.notice('warn', `${this.label()} 세션이 ${this.escalationLabel(mode)}(${mode.name})로 열려 앱 권한에 맞는 모드로 바꿨습니다.`);
  }

  /**
   * Codex: the thread is in a confirmed bypassPermissions (never for Auto review); Hermes: the mode the app itself
   * chose.
   */
  private isApprovedFullAccess(mode: AcpModeLite): boolean {
    if (this.agent !== 'codex') return this.approvedModeId === mode.id;
    return !isCodexAutoReviewMode(mode) && this.thread().permissionMode === 'bypassPermissions';
  }

  /** A mode the app must not run in unconfirmed: full-access-like, or Codex's Auto review (the agent approves itself). */
  private isEscalatedMode(mode: AcpModeLite): boolean {
    return isFullAccessMode(mode) || (this.agent === 'codex' && isCodexAutoReviewMode(mode));
  }

  /** Not an escalation, or one the user confirmed (a confirmed bypass may go back to Full access). */
  private isAllowedMode(mode: AcpModeLite): boolean {
    return !this.isEscalatedMode(mode) || this.isApprovedFullAccess(mode);
  }

  private escalationLabel(mode: AcpModeLite): string {
    return this.agent === 'codex' && isCodexAutoReviewMode(mode) ? '자동 리뷰 모드' : '전체 액세스 모드';
  }

  /** A mode to go back to: the previous allowed one, else the thread permission's (Codex) / the first safe one. */
  private safeModeTarget(previous: string | null): string | null {
    const modes = this.controls().modes;
    const prev = previous ? modes.find((m) => m.id === previous) : undefined;
    if (prev && this.isAllowedMode(prev)) return prev.id;
    if (this.agent === 'codex') {
      const id = codexModeFor(this.thread().permissionMode, modes);
      const m = modes.find((x) => x.id === id);
      return m && this.isAllowedMode(m) ? m.id : null;
    }
    return modes.find((m) => !this.isEscalatedMode(m))?.id ?? null;
  }

  /**
   * Codex: the permission chip may have changed while the process started (its launch env is older).
   * set_mode to the thread's mode; no matching mode or a failure -> respawn before the prompt (runTurn).
   */
  private async reconcilePermission(conn: AcpConnection, signal: AbortSignal, spawnedWith: UiPermissionMode | null): Promise<void> {
    // Every setPermissionMode up to here is in thread.permissionMode; later ones set the flag again.
    this.respawnNeeded = false;
    const wanted = this.thread().permissionMode;
    if (spawnedWith === null || sameCodexPermission(wanted, spawnedWith)) return;
    const controls = this.controls();
    const modeId = codexModeFor(wanted, controls.modes);
    if (!modeId) {
      this.respawnNeeded = true;
      return;
    }
    if (modeId === controls.currentModeId) return;
    try {
      await conn.request('session/set_mode', { sessionId: this.sessionId!, modeId }, this.timeouts.control, signal);
      this.updateControls({ currentModeId: modeId });
    } catch (err) {
      if (err instanceof AcpAbortedError || err instanceof AcpProcessExitedError) throw err;
      this.deps.log('[acp] set_mode for a changed permission failed; respawning', errName(err));
      this.respawnNeeded = true;
    }
  }

  private openConnection(spec: AcpLaunchSpec, cwd: string): AcpConnection {
    const opts: AcpConnectionOptions = {
      spec,
      cwd,
      appVersion: this.deps.appVersion,
      log: this.deps.log,
      handlers: {
        onUpdate: (n) => this.onUpdate(conn, n),
        onPermission: (params, signal) => this.onPermission(conn, params, signal),
      },
    };
    const conn: AcpConnection = this.deps.connect ? this.deps.connect(opts) : new AcpConnection(opts);
    return conn;
  }

  /** Synchronous (plan 2.3): the reducer result is applied before the next notification is read. */
  private onUpdate(conn: AcpConnection, n: SessionNotification): void {
    if (conn !== this.conn || this.retired) return;
    if (this.replay) {
      // History is already in the thread log: only controls / context are kept.
      this.replay.count += 1;
      const r = reduceAcpUpdate(initialAcpReducerState(this.threadId, 0), n.update, this.deps.now());
      this.applySignals(r.signals, true);
      return;
    }
    const r = reduceAcpUpdate(this.reducer, n.update, this.deps.now());
    this.reducer = r.state;
    this.emitReduced(r.events);
    this.applySignals(r.signals);
  }

  private onPermission(
    conn: AcpConnection,
    params: Parameters<AcpConnectionOptions['handlers']['onPermission']>[0],
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (conn !== this.conn || this.retired || this.replay || this.interrupted) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    return this.deps.broker.requestAcp(this.threadId, this.agent, params, signal);
  }

  /** `replay`: history of a `session/load` (mode changes there are past, not live switches: no mirror / revert). */
  private applySignals(signals: AcpSignal[], replay = false): void {
    for (const s of signals) {
      if (s.type === 'context') this.safePatch({ ctxPercent: s.percent });
      else if (s.type === 'config') {
        this.updateControls({ configOptions: s.configOptions });
        this.syncThreadConfig(s.configOptions);
      } else if (s.type === 'commands') {
        this.updateControls({ commands: s.commands });
      } else if (s.type === 'mode') {
        const previous = this.controls().currentModeId;
        this.updateControls({ currentModeId: s.currentModeId });
        if (replay) continue;
        if (this.revertUnapprovedFullAccess(s.currentModeId, previous)) continue;
        if (this.agent === 'codex') this.mirrorCodexMode(s.currentModeId);
      }
    }
  }

  /**
   * The agent switched itself to a full-access-like mode the user never confirmed (Codex: thread not in
   * bypassPermissions, or Auto review at any time; Hermes: not the mode the app chose): set_mode straight back, or
   * kill the process (the next turn respawns with the thread's permission). True when the switch was refused.
   */
  private revertUnapprovedFullAccess(modeId: string, previous: string | null): boolean {
    const modes = this.controls().modes;
    const mode = modes.find((m) => m.id === modeId);
    if (!mode || !this.isEscalatedMode(mode)) return false;
    if (this.isApprovedFullAccess(mode)) return false;
    this.notice('warn', `${this.label()}가 스스로 ${this.escalationLabel(mode)}(${mode.name})로 바꿔 이전 모드로 되돌렸습니다.`);
    const target = this.safeModeTarget(previous);
    const conn = this.conn;
    const sessionId = this.sessionId;
    const killForRespawn = (): void => {
      this.respawnNeeded = true;
      conn?.kill();
    };
    if (!conn || !sessionId || !target) {
      killForRespawn();
      return true;
    }
    conn.request('session/set_mode', { sessionId, modeId: target }, this.timeouts.control).then(
      () => {
        if (this.conn === conn) this.updateControls({ currentModeId: target });
      },
      (err: unknown) => {
        this.deps.log('[acp] reverting a full-access mode failed; killing the agent', errName(err));
        killForRespawn();
      },
    );
    return true;
  }

  /** Agent-side mode switch -> app permission chip; never escalates to bypass (that needs the confirm dialog). */
  private mirrorCodexMode(modeId: string): void {
    const mode = this.controls().modes.find((m) => m.id === modeId);
    const perm = mode ? permissionForCodexMode(mode) : null;
    if (!perm || perm === 'bypassPermissions') return;
    const current = this.thread().permissionMode;
    // default and acceptEdits both map to the workspace mode.
    if (current === perm || (perm === 'default' && current === 'acceptEdits')) return;
    this.safePatch({ permissionMode: perm });
  }

  /** Codex: thread model / effort follow the session's config options (next spawn's `CODEX_CONFIG` too). */
  private syncThreadConfig(options: readonly AcpConfigOptionLite[]): void {
    if (this.agent !== 'codex') return;
    const thread = this.deps.store.getThread(this.threadId);
    if (!thread) return;
    const patch: Partial<Thread> = {};
    const model = options.find((o) => o.category === 'model' && o.type === 'select');
    if (model && model.type === 'select' && model.currentValue && model.currentValue !== thread.model) {
      patch.model = model.currentValue;
    }
    const effort = options.find((o) => o.category === 'thought_level' && o.type === 'select');
    if (effort && effort.type === 'select' && isEffort(effort.currentValue) && effort.currentValue !== thread.effort) {
      patch.effort = effort.currentValue;
    }
    if (Object.keys(patch).length > 0) this.safePatch(patch);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private async resolveSpec(thread: Thread): Promise<AcpLaunchSpec | null> {
    const res = await this.deps.launcher.resolve(thread.cwd, {
      model: thread.model || null,
      effort: thread.effort,
      permissionMode: thread.permissionMode,
      ...(thread.projectId === null && this.deps.scratchRoot ? { gitCeiling: this.deps.scratchRoot } : {}),
    });
    if (!res.ok) return null;
    this.specPermission = thread.permissionMode;
    return res.spec;
  }

  /** The open connection when a session is usable now. */
  private liveConn(): AcpConnection | null {
    const conn = this.conn;
    if (!conn || conn.isGone || (this.state !== 'ready' && this.state !== 'prompting')) return null;
    return conn;
  }

  private dropConnection(conn: AcpConnection): void {
    if (this.conn !== conn) return;
    this.conn = null;
    this.sessionId = null;
    this.state = 'closed';
  }

  private async closeConnection(opts: { dispose?: boolean }): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const sessionId = this.sessionId;
    this.conn = null;
    this.sessionId = null;
    this.state = 'closing';
    this.closing.add(conn);
    try {
      await conn.close({ sessionId, dispose: opts.dispose });
    } finally {
      this.closing.delete(conn);
      if (!this.conn) this.state = 'closed';
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    const minutes = this.deps.store.get().settings.idleCloseMinutes;
    if (!(minutes > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.busy || this.retired) return;
      this.enqueue(() => this.closeConnection({}).catch((err: unknown) => this.deps.log('[acp] idle close failed', err)));
    }, minutes * MINUTE_MS);
  }

  /** Runs `task` (which handles its own errors) after everything queued before it; whenSettled awaits the chain. */
  private enqueue(task: () => Promise<void>): void {
    this.work = this.work.catch(() => {}).then(task);
  }

  /** Confirms streaming text / unfinished tools of the current reducer (persisted); returns its settled tools. */
  private flushReducer(): AcpReducerState['settledTools'] {
    const fin = finalizeAcpTurn(this.reducer, 'end_turn', this.deps.now());
    if (!this.retired) this.emitReduced(fin.events);
    return fin.state.settledTools;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearCancelTimer(): void {
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // State / events
  // -------------------------------------------------------------------------

  private thread(): Thread {
    const thread = this.deps.store.getThread(this.threadId);
    if (!thread) throw new Error(`thread not found: ${this.threadId}`);
    return thread;
  }

  private controls(): AcpControls {
    return this.deps.store.getThread(this.threadId)?.acp?.controls ?? EMPTY_CONTROLS;
  }

  private patch(patch: Partial<Thread>): void {
    const thread = this.deps.store.patchThread(this.threadId, patch);
    this.deps.broadcaster.emit('thread:updated', { ...thread });
  }

  private safePatch(patch: Partial<Thread>): void {
    try {
      this.patch(patch);
    } catch (err) {
      this.deps.log('[acp] thread patch failed', err);
    }
  }

  private patchAcp(patch: Partial<ThreadAcpState>): void {
    const prev = this.deps.store.getThread(this.threadId)?.acp;
    const next: ThreadAcpState = { sessionId: prev?.sessionId ?? null, controls: prev?.controls ?? null, ...prev, ...patch };
    this.safePatch({ acp: next });
  }

  private updateControls(patch: Partial<AcpControls>): void {
    const controls: AcpControls = { ...this.controls(), ...patch };
    this.patchAcp({ controls });
    this.broadcastControls(controls);
  }

  private broadcastControls(controls: AcpControls): void {
    this.deps.broadcaster.emit('agent:controls', { threadId: this.threadId, controls });
  }

  /** Reducer events with ids namespaced per connection (reducer ids restart with each connection). */
  private emitReduced(events: ChatEvent[]): void {
    for (const event of events) {
      if (event.type === 'text-delta') this.emitEvent({ ...event, itemId: `${this.tag}:${event.itemId}` });
      else if (event.type === 'item-upsert') this.emitItem({ ...event.item, id: `${this.tag}:${event.item.id}` } as ChatItem);
      else this.emitEvent(event);
    }
  }

  private emitEvent(event: ChatEvent): void {
    this.deps.broadcaster.emit('chat:event', { threadId: this.threadId, event });
  }

  private emitItem(item: ChatItem): void {
    this.emitEvent({ type: 'item-upsert', item });
    this.deps.threadLog
      .append(this.threadId, item)
      .catch((err: unknown) => this.deps.log('[acp] thread log append failed', err));
  }

  private notice(level: SystemNoticeItem['level'], text: string): void {
    if (this.retired) return;
    this.emitItem({ type: 'notice', id: newId('notice'), level, text, createdAt: this.deps.now() });
  }

  /** `error` ChatEvent + the same text persisted as an error notice (ThreadRunner pattern). */
  private reportError(message: string): void {
    if (this.retired) return;
    this.emitEvent({ type: 'error', message });
    const item: SystemNoticeItem = { type: 'notice', id: newId('error'), level: 'error', text: message, createdAt: this.deps.now() };
    this.deps.threadLog
      .append(this.threadId, item)
      .catch((err: unknown) => this.deps.log('[acp] thread log append failed', err));
  }

  private label(): string {
    return AGENTS[this.agent].name;
  }

  private authMessage(): string {
    return this.agent === 'codex'
      ? 'Codex 로그인이 필요합니다. ChatGPT 앱에서 로그인하거나 터미널에서 `codex login`을 실행한 뒤 다시 보내세요.'
      : 'Hermes 로그인이 필요합니다. 터미널에서 `hermes acp --setup`을 실행한 뒤 다시 보내세요.';
  }

  private exitMessage(err: unknown, conn: AcpConnection): string {
    const tail = err instanceof AcpProcessExitedError ? err.stderrTail : conn.stderrTail();
    return `${this.label()} 프로세스가 종료되었습니다.${tail ? `\n${tail}` : ''}`;
  }

  private openErrorMessage(err: unknown): string {
    if (err instanceof AcpSpawnError) return `${this.label()} 실행 파일을 시작할 수 없습니다: ${err.code}`;
    if (err instanceof AcpProtocolVersionError) return `지원하지 않는 ACP 버전입니다 (${this.label()}: ${String(err.version)}).`;
    if (err instanceof AcpTimeoutError) return `${this.label()}가 응답하지 않습니다 (${err.method} 시간 초과).`;
    if (err instanceof AcpProcessExitedError) {
      return `${this.label()}를 시작하지 못했습니다: 프로세스가 종료되었습니다.${err.stderrTail ? `\n${err.stderrTail}` : ''}`;
    }
    return `${this.label()}를 시작하지 못했습니다: ${redact(errText(err))}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Codex's own effort set (a session-reported value outside it is not copied to the thread / `CODEX_CONFIG`). */
function isEffort(value: string): value is CodexEffortLevel {
  return (CODEX_EFFORT_LEVELS as readonly string[]).includes(value);
}

/** default and acceptEdits share codex's `workspace-write` mode (agentDefaults CODEX_MODE_BY_PERMISSION). */
function sameCodexPermission(a: UiPermissionMode, b: UiPermissionMode): boolean {
  const norm = (m: UiPermissionMode) => (m === 'acceptEdits' ? 'default' : m);
  return norm(a) === norm(b);
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** JSON-RPC `-32000` or an auth message (codex-acp "Authentication required"). */
function isAuthError(err: unknown): boolean {
  return err instanceof RequestError && (err.code === -32000 || /auth/i.test(err.message));
}

/** load / resume errors after which a new session is opened (the agent answered; not auth). */
function isFallbackError(err: unknown): boolean {
  return err instanceof RequestError && !isAuthError(err);
}

/** Config options of a response in the composer's shape (reuses the reducer's `config_option_update` mapping). */
function liteConfigOptions(threadId: string, raw: unknown): AcpConfigOptionLite[] {
  if (!Array.isArray(raw)) return [];
  const r = reduceAcpUpdate(
    initialAcpReducerState(threadId, 0),
    { sessionUpdate: 'config_option_update', configOptions: raw } as never,
    0,
  );
  const signal = r.signals.find((s) => s.type === 'config');
  return signal?.type === 'config' ? signal.configOptions : [];
}

/** `modes` / `configOptions` / Hermes `models.currentModelId` of a new / load / resume response (read defensively). */
function controlsFrom(threadId: string, res: unknown): AcpControls {
  const r = isRecord(res) ? res : {};
  const modesRaw = isRecord(r.modes) ? r.modes : null;
  const modes: AcpModeLite[] = [];
  if (modesRaw && Array.isArray(modesRaw.availableModes)) {
    for (const m of modesRaw.availableModes.slice(0, MAX_MODES)) {
      if (!isRecord(m) || typeof m.id !== 'string') continue;
      modes.push({
        id: m.id,
        name: (typeof m.name === 'string' ? m.name : m.id).slice(0, MAX_LABEL_CHARS),
        ...(typeof m.description === 'string' ? { description: m.description.slice(0, MAX_LABEL_CHARS) } : {}),
      });
    }
  }
  const models = isRecord(r.models) ? r.models : null;
  const reported = typeof models?.currentModelId === 'string' ? models.currentModelId.slice(0, REPORTED_MODEL_MAX) : null;
  return {
    modes,
    currentModeId: modesRaw && typeof modesRaw.currentModeId === 'string' ? modesRaw.currentModeId : null,
    configOptions: liteConfigOptions(threadId, r.configOptions),
    reportedModel: reported || null,
  };
}

function withCurrentValue(o: AcpConfigOptionLite, configId: string, value: string | boolean): AcpConfigOptionLite {
  if (o.id !== configId) return o;
  if (o.type === 'boolean' && typeof value === 'boolean') return { ...o, currentValue: value };
  if (o.type === 'select' && typeof value === 'string') return { ...o, currentValue: value };
  return o;
}

/** plan 2.15: app permission chip -> codex-acp 2.x session mode id, when the session offers it. Never `agent`. */
export function codexModeFor(mode: UiPermissionMode, modes: readonly AcpModeLite[]): string | null {
  const id = CODEX_MODE_BY_PERMISSION[mode];
  return id !== undefined && modes.some((m) => m.id === id) ? id : null;
}

/** Reverse of codexModeFor (agent-side mode switches); `agent` (Auto review) and unknown ids map to nothing. */
function permissionForCodexMode(m: AcpModeLite): UiPermissionMode | null {
  if (m.id === CODEX_MODE_BY_PERMISSION.plan) return 'plan';
  if (m.id === CODEX_MODE_BY_PERMISSION.bypassPermissions) return 'bypassPermissions';
  if (m.id === CODEX_MODE_BY_PERMISSION.default) return 'default';
  return null;
}
