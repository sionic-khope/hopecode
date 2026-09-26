// One thread = at most one live streaming-input Query (plan 4.2 session/threadRunner.ts, flow 7.2).
// Turn start picks an account; a different account closes the old Query (awaiting the consumer loop,
// i.e. CLI exit) before the transcript is copied from lastAccountId and the new Query resumes it.
import { randomUUID } from 'node:crypto';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createChatReducerState, reduceSdkMessage } from '../../core/chatReducer';
import { pickAccount } from '../../core/rotationPolicy';
import {
  CLIENT_APP_NAME,
  CONTINUE_PROMPT,
  MINUTE_MS,
  SESSION_CLEANUP_PERIOD_DAYS,
  SESSION_ID_PATTERN,
} from '../../shared/constants';
import type {
  Account,
  ChatEvent,
  ChatItem,
  ChatReducerState,
  ChatSendResult,
  EffortLevel,
  PendingPrompt,
  RateLimitInfoLite,
  SystemNoticeItem,
  Thread,
  TurnEndReason,
  UiPermissionMode,
} from '../../shared/types';
import type { Broadcaster, ClaudeBinary, QueryFn, ShellEnv, Store, ThreadLog, UsagePoller } from '../contracts';
import type { PermissionBroker } from './permissionBroker';
import type { SyncTranscriptFn } from './transcriptSync';

export interface ThreadRunnerDeps {
  query: QueryFn;
  store: Pick<Store, 'get' | 'getThread' | 'patchThread'>;
  threadLog: Pick<ThreadLog, 'append'>;
  listAccounts: () => Account[];
  usage: Pick<UsagePoller, 'refresh' | 'reportRateLimit' | 'markAuthFailed' | 'getSnapshot'>;
  shellEnv: Pick<ShellEnv, 'childEnv'>;
  claudeBinary: Pick<ClaudeBinary, 'resolvePath'>;
  broadcaster: Broadcaster;
  broker: PermissionBroker;
  syncTranscript: SyncTranscriptFn;
  appVersion: string;
  /** Waiting-state registration (WaitScheduler.track / untrack). */
  onWaiting: (threadId: string, waiting: boolean) => void;
  onCliVersion?: (version: string) => void;
  /** A Query reported its init message (the manager refreshes the model catalog from the first live session). */
  onSessionInit?: () => void;
  now: () => number;
  log: (message: string, err?: unknown) => void;
}

interface ActiveQuery {
  accountId: string;
  q: Query;
  input: InputQueue;
  /** Project trust at open time (settingSources); a change reopens the Query on the next turn. */
  trusted: boolean;
  abort: AbortController;
  reducer: ChatReducerState;
  /** Prefix that keeps reducer item ids unique across Queries of the same thread. */
  tag: string;
  loopDone: Promise<void>;
  /** Reducer id of a partial text flushed mid-block; the block's late complete message upserts that item. */
  flushedPartialId: string | null;
}

interface TurnState {
  active: ActiveQuery;
  accountId: string;
  ended: boolean;
  reason?: TurnEndReason;
  gotOutput: boolean;
  lastRateLimit?: RateLimitInfoLite;
  done: Promise<void>;
  resolve: () => void;
}

interface SwitchedFrom {
  accountId: string;
  reason: TurnEndReason;
  info?: RateLimitInfoLite;
}

/** Streaming input for the long-lived Query. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage, undefined>) => void)[] = [];
  private ended = false;

  push(message: SDKUserMessage): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  end(): void {
    this.ended = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, undefined> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

const ALL_AUTH_FAILED_TEXT = '모든 계정의 인증이 만료되었습니다. 계정 화면에서 다시 로그인하세요.';

function switchReasonLabel(from: SwitchedFrom): string {
  if (from.reason === 'auth') return '인증 실패';
  switch (from.info?.rateLimitType) {
    case 'five_hour':
      return '5시간 한도 도달';
    case 'seven_day':
    case 'seven_day_opus':
    case 'seven_day_sonnet':
    case 'seven_day_overage_included':
      return '주간 한도 도달';
    case 'overage':
      return '추가 사용량 차단';
    default:
      return '사용 한도 도달';
  }
}

export class ThreadRunner {
  private active: ActiveQuery | null = null;
  private turn: TurnState | null = null;
  /** True from account decision until the turn chain settles (guards concurrent sends). */
  private busy = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private work: Promise<void> = Promise.resolve();
  /** Set by close(): the thread is gone (deleted) or the app is quitting; nothing may start or retry. */
  private closed = false;
  /** In-flight Query shutdown (CLI exit); a new Query waits for it so transcripts are never written twice. */
  private closing: Promise<void> | null = null;
  /** Stop pressed while no turn was live (Query opening / between retries); honored at the next step. */
  private abortRequested = false;
  /** Queries closed but whose CLI has not exited yet (abort() kills them on the quit timeout). */
  private readonly closingQueries = new Set<ActiveQuery>();
  /** Query being prepared (close/sync awaits) for this account; account removal waits for it. */
  private preparing: { accountId: string; done: Promise<unknown> } | null = null;

  constructor(
    readonly threadId: string,
    private readonly deps: ThreadRunnerDeps,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async send(text: string): Promise<ChatSendResult> {
    const thread = this.thread();
    if (thread.status === 'waiting') {
      const prev = thread.pendingPrompt;
      const merged: PendingPrompt = {
        text: prev?.kind === 'continue' ? `${CONTINUE_PROMPT}\n\n${text}` : text,
        kind: 'original',
      };
      this.patch({ pendingPrompt: merged });
      this.emitItem({ type: 'user', id: this.newId('user'), text, createdAt: this.deps.now() });
      return { accepted: true, reason: 'waiting' };
    }
    if (this.busy || thread.status === 'running') return { accepted: false, reason: 'busy' };
    this.clearIdleTimer();
    this.abortRequested = false;
    return this.runTurn({ text, kind: 'original' }, new Set(), null, text);
  }

  /** Waiting thread re-evaluation (WaitScheduler). `due` -> refresh usage before picking. */
  async resumeWaiting(due: boolean): Promise<void> {
    const thread = this.thread();
    if (thread.status !== 'waiting' || this.busy) {
      if (thread.status !== 'waiting') this.deps.onWaiting(this.threadId, false);
      return;
    }
    if (due) {
      try {
        await this.deps.usage.refresh();
      } catch (err) {
        this.deps.log('[session] usage refresh before resume failed', err);
      }
      if (this.closed) return;
    }
    const current = this.thread();
    if (current.status !== 'waiting') return;
    const prompt = current.pendingPrompt;
    const decision = this.pick(new Set());
    if (decision.type === 'waiting') {
      if (due) this.patch({ waitingUntil: decision.until });
      return;
    }
    this.deps.onWaiting(this.threadId, false);
    if (decision.type === 'none' || !prompt) {
      this.patch({ status: 'idle', waitingUntil: null, pendingPrompt: null });
      if (decision.type === 'none') {
        this.notice(
          'error',
          decision.reason === 'auth'
            ? `${ALL_AUTH_FAILED_TEXT} 대기를 취소했습니다.`
            : '사용할 수 있는 계정이 없어 대기를 취소했습니다.',
        );
      }
      return;
    }
    this.patch({ waitingUntil: null });
    this.abortRequested = false;
    await this.runTurn(prompt, new Set(), null, null);
  }

  async interrupt(): Promise<void> {
    const thread = this.thread();
    if (thread.status === 'waiting') {
      this.deps.onWaiting(this.threadId, false);
      this.patch({ status: 'idle', pendingPrompt: null, waitingUntil: null });
      return;
    }
    const turn = this.turn;
    if (!turn || turn.ended) {
      // Query still opening, or a rejected turn is about to be retried: stop at the next step (L2).
      if (this.busy) this.abortRequested = true;
      return;
    }
    turn.reason = 'interrupted';
    this.deps.broker.cancelThread(this.threadId);
    try {
      await turn.active.q.interrupt();
    } catch (err) {
      this.deps.log('[session] interrupt failed', err);
    }
  }

  async setPermissionMode(mode: UiPermissionMode): Promise<void> {
    this.patch({ permissionMode: mode });
    if (this.active) await this.active.q.setPermissionMode(mode);
  }

  /** The CLI already switched modes (accepted `setMode` suggestion): mirror it in the store only. */
  applySessionPermissionMode(mode: UiPermissionMode): void {
    if (this.closed || this.deps.store.getThread(this.threadId)?.permissionMode === mode) return;
    this.patch({ permissionMode: mode });
  }

  /** Account of the live Query, if any. */
  activeAccountId(): string | null {
    return this.active?.accountId ?? null;
  }

  /**
   * Account removal: stop using `accountId` without retiring the runner. Resolves once nothing of this runner
   * runs on it: a Query being prepared for it has settled, its Query's CLI exited and the cut turn finished.
   */
  async releaseAccount(accountId: string): Promise<void> {
    const preparing = this.preparing;
    if (preparing?.accountId === accountId) await preparing.done.catch(() => {});
    const active = this.active;
    if (active?.accountId === accountId) {
      const turn = this.turn;
      const cut = turn && turn.active === active && !turn.ended ? turn : null;
      const work = this.work;
      const alias = this.account(accountId)?.alias ?? accountId;
      this.clearIdleTimer();
      await this.closeQuery();
      if (cut) {
        if (!this.closed) this.notice('warn', `중단됨: ${alias} 계정이 제거되었습니다.`);
        await work;
      }
    }
    for (const q of [...this.closingQueries]) {
      if (q.accountId === accountId) await q.loopDone;
    }
  }

  /** Quit timeout: kill the CLI processes now (live and still-closing ones) instead of waiting for a graceful exit. */
  abort(): void {
    this.closed = true;
    this.clearIdleTimer();
    this.active?.abort.abort();
    for (const q of this.closingQueries) q.abort.abort();
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    this.patch({ effort });
    // `effortLevel: null` returns the live session to the model's default effort.
    if (this.active) await this.active.q.applyFlagSettings({ effortLevel: effort });
  }

  async setModel(model: string): Promise<void> {
    this.patch({ model, resolvedModel: model === 'default' ? null : model });
    if (this.active) await this.active.q.setModel(model === 'default' ? undefined : model);
  }

  /** Live Query (for supportedModels()). */
  query(): Query | null {
    return this.active?.q ?? null;
  }

  /** Retire the runner (thread deleted / app quit): no further turn, retry or patch; waits for CLI exit. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    await this.closeQuery();
  }

  /** Resolves when the current turn chain (including retries / ctx fetch) has settled. */
  async whenSettled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.work;
      await current;
    } while (current !== this.work);
  }

  // -------------------------------------------------------------------------
  // Turn flow (plan 7.2)
  // -------------------------------------------------------------------------

  private pick(tried: Set<string>) {
    const thread = this.thread();
    return pickAccount({
      accounts: this.candidateAccounts(thread),
      usageById: this.deps.usage.getSnapshot().usageById,
      pinnedAccountId: thread.pinnedAccountId,
      resolvedModel: thread.resolvedModel,
      model: thread.model,
      exclude: tried,
      now: this.deps.now(),
    });
  }

  /**
   * Accounts this turn may use. With automatic switching off (settings.autoSwitchAccounts), a thread that already
   * ran on an account stays on it: a rate-limited turn then waits for that account's reset instead of moving on.
   * A thread with no account yet (first turn) picks from the whole pool.
   */
  private candidateAccounts(thread: Thread): Account[] {
    const accounts = this.deps.listAccounts();
    if (this.deps.store.get().settings.autoSwitchAccounts !== false) return accounts;
    const homeId = thread.activeAccountId ?? thread.lastAccountId;
    const home = homeId ? accounts.find((a) => a.id === homeId && a.enabled) : undefined;
    return home ? [home] : accounts;
  }

  private account(accountId: string | null): Account | undefined {
    if (!accountId) return undefined;
    return this.deps.listAccounts().find((a) => a.id === accountId);
  }

  /** Still present and enabled (account:remove disables first, then removes). */
  private usable(accountId: string): boolean {
    return this.account(accountId)?.enabled === true;
  }

  private async runTurn(
    prompt: PendingPrompt,
    tried: Set<string>,
    switchedFrom: SwitchedFrom | null,
    userText: string | null,
  ): Promise<ChatSendResult> {
    const decision = this.pick(tried);

    if (decision.type === 'none') {
      const auth = decision.reason === 'auth';
      if (switchedFrom) {
        this.patch({ status: 'idle', pendingPrompt: null });
        this.notice('error', auth ? ALL_AUTH_FAILED_TEXT : `전환할 다른 계정이 없습니다 (${switchReasonLabel(switchedFrom)}).`);
      }
      return { accepted: false, reason: auth ? 'auth' : 'no-accounts' };
    }

    if (userText !== null) {
      this.emitItem({ type: 'user', id: this.newId('user'), text: userText, createdAt: this.deps.now() });
    }

    if (decision.type === 'waiting') {
      this.patch({ status: 'waiting', waitingUntil: decision.until, pendingPrompt: prompt });
      this.deps.onWaiting(this.threadId, true);
      const pinnedHome = this.deps.store.get().settings.autoSwitchAccounts === false && this.candidateAccounts(this.thread()).length === 1;
      const who = pinnedHome ? `${this.candidateAccounts(this.thread())[0]?.alias ?? '이'} 계정이 한도에 도달했습니다` : '모든 계정이 한도에 도달했습니다';
      const detail = [switchedFrom ? switchReasonLabel(switchedFrom) : null, pinnedHome ? '자동 전환 꺼짐' : null].filter(Boolean).join(' · ');
      this.notice('warn', `${who}${detail ? ` (${detail})` : ''}. 초기화되면 자동으로 이어갑니다.`);
      return { accepted: true, reason: 'waiting' };
    }

    const accountId = decision.accountId;
    this.busy = true;
    this.patch({ status: 'running', activeAccountId: accountId, pendingPrompt: prompt, waitingUntil: null });
    if (switchedFrom) {
      const from = this.account(switchedFrom.accountId)?.alias ?? switchedFrom.accountId;
      const to = this.account(accountId)?.alias ?? accountId;
      this.notice('info', `계정 전환: ${from} → ${to} (${switchReasonLabel(switchedFrom)})`);
    }

    let active: ActiveQuery | null;
    const preparing = this.prepareQuery(accountId);
    this.preparing = { accountId, done: preparing };
    try {
      active = await preparing;
    } catch (err) {
      this.busy = false;
      if (this.closed) return { accepted: true };
      this.deps.log('[session] failed to open query', err);
      this.safePatch({ status: 'error', pendingPrompt: null });
      this.reportError(`Claude Code를 시작하지 못했습니다: ${errorText(err)}`);
      return { accepted: true };
    } finally {
      if (this.preparing?.done === preparing) this.preparing = null;
    }

    if (!active) {
      // The account was disabled / removed while the Query was being prepared: decide again without it.
      this.busy = false;
      const retried = await this.runTurn(prompt, new Set(tried).add(accountId), switchedFrom, null);
      if (!retried.accepted && !switchedFrom) {
        this.safePatch({ status: 'idle', activeAccountId: null, pendingPrompt: null });
        this.notice('error', retried.reason === 'auth' ? ALL_AUTH_FAILED_TEXT : '사용할 수 있는 계정이 없습니다.');
      }
      return retried;
    }

    if (this.closed) {
      this.busy = false;
      await this.closeQuery();
      return { accepted: true };
    }
    if (this.abortRequested) {
      this.abortRequested = false;
      this.busy = false;
      this.emitEvent({ type: 'turn-end', ok: false, reason: 'interrupted' });
      this.patch({ status: 'idle', pendingPrompt: null });
      this.scheduleIdleClose();
      return { accepted: true };
    }

    if (this.thread().sessionStartedAt === null) this.patch({ sessionStartedAt: this.deps.now() });

    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const turn: TurnState = { active, accountId, ended: false, gotOutput: false, done, resolve };
    this.turn = turn;
    // A partial text left by an earlier cut-off turn is finalized; streaming state starts clean (M2).
    this.flushPartial(active);
    active.flushedPartialId = null;
    // `output` is emitted once per reducer state; re-arm it per turn (gotOutput decides the retry prompt).
    active.reducer = { ...active.reducer, outputEmitted: false };

    this.emitEvent({ type: 'turn-start', accountId });
    active.input.push({
      type: 'user',
      message: { role: 'user', content: prompt.text },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    });

    this.work = this.finishTurn(turn, prompt, tried).catch((err: unknown) => {
      this.busy = false;
      if (this.closed) return;
      this.deps.log('[session] turn failed', err);
      this.safePatch({ status: 'error', pendingPrompt: null });
    });
    return { accepted: true };
  }

  private async finishTurn(turn: TurnState, prompt: PendingPrompt, tried: Set<string>): Promise<void> {
    await turn.done;
    if (this.turn === turn) this.turn = null;
    this.flushPartial(turn.active);
    if (this.closed) {
      this.busy = false;
      return;
    }
    const reason = turn.reason;

    if (reason === 'rate_limited' || reason === 'auth') {
      this.emitEvent({ type: 'turn-end', ok: false, reason });
      // Rejected account's Query is closed (CLI exit awaited) before any transcript copy.
      await this.closeQuery();
      this.busy = false;
      // Deleted thread / quitting: never retry (H4). Stop pressed meanwhile: do not retry (L2).
      if (this.closed) return;
      if (this.abortRequested) {
        this.abortRequested = false;
        this.patch({ status: 'idle', pendingPrompt: null });
        return;
      }
      const retry: PendingPrompt = turn.gotOutput ? { text: CONTINUE_PROMPT, kind: 'continue' } : prompt;
      const nextTried = new Set(tried).add(turn.accountId);
      await this.runTurn(retry, nextTried, { accountId: turn.accountId, reason, info: turn.lastRateLimit }, null);
      return;
    }

    this.busy = false;
    this.abortRequested = false;
    this.emitEvent({ type: 'turn-end', ok: reason === undefined, ...(reason ? { reason } : {}) });
    this.patch({ status: 'idle', pendingPrompt: null });

    const active = this.active;
    if (active && active === turn.active) {
      try {
        const ctx = await active.q.getContextUsage({ detail: 'summary' });
        if (this.closed) return;
        if (typeof ctx?.percentage === 'number') this.patch({ ctxPercent: ctx.percentage });
      } catch (err) {
        this.deps.log('[session] getContextUsage failed', err);
      }
      if (!this.closed) this.scheduleIdleClose();
    }
  }

  // -------------------------------------------------------------------------
  // Query lifecycle
  // -------------------------------------------------------------------------

  /** Live Query for `accountId`, or null when the account stopped being usable during the awaits (re-pick). */
  private async prepareQuery(accountId: string): Promise<ActiveQuery | null> {
    const trusted = this.projectTrusted();
    if (this.active && (this.active.accountId !== accountId || this.active.trusted !== trusted)) await this.closeQuery();
    // A Query closed just before (idle close, account switch) must finish exiting first (M3).
    while (this.closing) await this.closing;
    this.assertOpen();
    if (!this.usable(accountId)) return null;
    if (this.active) return this.active;

    const account = this.account(accountId);
    if (!account) return null;

    const thread = this.thread();
    // Session ids end up in transcript paths: only well-formed SDK UUIDs are resumed (L10).
    const sessionId = thread.sdkSessionId && SESSION_ID_PATTERN.test(thread.sdkSessionId) ? thread.sdkSessionId : null;
    let resume: string | undefined;
    if (sessionId && thread.lastAccountId) {
      if (thread.lastAccountId === accountId) {
        resume = sessionId;
      } else {
        const source = this.account(thread.lastAccountId);
        let found = false;
        if (source) {
          try {
            found = (await this.deps.syncTranscript(sessionId, source.configDir, account.configDir)).found;
          } catch (err) {
            this.deps.log('[session] transcript sync failed', err);
          }
          this.assertOpen();
          if (!this.usable(accountId)) return null;
        }
        if (found) resume = sessionId;
        else this.notice('warn', '이전 대화 기록을 찾지 못해 새 세션으로 시작합니다.');
      }
    } else if (thread.sdkSessionId && !sessionId) {
      this.notice('warn', '이전 세션 ID가 올바르지 않아 새 세션으로 시작합니다.');
    }

    return this.openQuery(account, resume, trusted);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`thread runner closed: ${this.threadId}`);
  }

  private projectTrusted(): boolean {
    const projectId = this.thread().projectId;
    return this.deps.store.get().projects.find((p) => p.id === projectId)?.trusted === true;
  }

  private openQuery(account: Account, resume: string | undefined, trusted: boolean): ActiveQuery {
    const thread = this.thread();
    const input = new InputQueue();
    const abort = new AbortController();
    const options: Options = {
      cwd: thread.cwd,
      ...(thread.model && thread.model !== 'default' ? { model: thread.model } : {}),
      permissionMode: thread.permissionMode,
      ...(thread.effort ? { effort: thread.effort } : {}),
      // Always set so the UI can switch to bypassPermissions at runtime via setPermissionMode.
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      canUseTool: this.deps.broker.canUseToolFor(this.threadId),
      // Repo `.claude` settings (hooks, permissions) only load for a folder the user trusted.
      settingSources: trusted ? ['user', 'project', 'local'] : ['user'],
      settings: { cleanupPeriodDays: SESSION_CLEANUP_PERIOD_DAYS },
      pathToClaudeCodeExecutable: this.deps.claudeBinary.resolvePath(),
      env: this.deps.shellEnv.childEnv({
        configDir: account.configDir,
        clientApp: `${CLIENT_APP_NAME}/${this.deps.appVersion}`,
      }),
      stderr: (data: string) => this.deps.log(`[claude:${this.threadId}] ${data.trimEnd()}`),
      abortController: abort,
      ...(resume ? { resume } : {}),
    };
    const q = this.deps.query({ prompt: input, options });
    const active: ActiveQuery = {
      accountId: account.id,
      q,
      input,
      trusted,
      abort,
      reducer: createChatReducerState(this.threadId),
      tag: randomUUID().slice(0, 8),
      loopDone: Promise.resolve(),
      flushedPartialId: null,
    };
    active.loopDone = this.consume(active);
    this.active = active;
    return active;
  }

  private async closeQuery(): Promise<void> {
    const active = this.active;
    if (!active) {
      if (this.closing) await this.closing;
      return;
    }
    this.clearIdleTimer();
    this.active = null;
    const turn = this.turn;
    if (turn && turn.active === active && !turn.ended && !turn.reason) turn.reason = 'interrupted';
    this.deps.broker.cancelThread(this.threadId);
    active.input.end();
    try {
      active.q.close();
    } catch (err) {
      this.deps.log('[session] query close failed', err);
    }
    // Query.close() returning does not mean the CLI exited / flushed the transcript: wait for the loop.
    const closing = active.loopDone;
    this.closing = closing;
    this.closingQueries.add(active);
    try {
      await closing;
    } finally {
      this.closingQueries.delete(active);
      if (this.closing === closing) this.closing = null;
    }
  }

  private async consume(active: ActiveQuery): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const msg of active.q) this.handleMessage(active, msg);
    } catch (err) {
      this.deps.log('[session] query stream failed', err);
      failure = errorText(err);
    } finally {
      // Still ours = not closed by us: the CLI died or the stream broke (contract 6: surface it).
      const unexpected = this.active === active && !this.closed;
      if (this.active === active) this.active = null;
      this.flushPartial(active);
      const turn = this.turn;
      if (turn && turn.active === active && !turn.ended) {
        if (unexpected && !turn.reason) {
          this.reportError(failure ? `Claude Code가 중지되었습니다: ${failure}` : 'Claude Code가 예기치 않게 종료되었습니다.');
        }
        this.endTurn(turn, turn.reason ?? 'error');
      }
    }
  }

  private handleMessage(active: ActiveQuery, msg: SDKMessage): void {
    if (active.flushedPartialId !== null) {
      // The complete message of a block flushed early (rate-limit cut) reuses the flushed item's id (upsert).
      if (msg.type === 'assistant' && active.reducer.streamingItemId === null && hasTextBlock(msg)) {
        active.reducer = { ...active.reducer, streamingItemId: active.flushedPartialId };
      }
      if (msg.type === 'assistant' || isTextDelta(msg)) active.flushedPartialId = null;
    }
    const { state, events, signals } = reduceSdkMessage(active.reducer, msg, this.deps.now());
    active.reducer = state;
    const accountId = active.accountId;
    const liveTurn = this.turn && this.turn.active === active && !this.turn.ended ? this.turn : null;

    let reported = false;
    for (const signal of signals) {
      switch (signal.type) {
        case 'output':
          if (liveTurn && !liveTurn.gotOutput) {
            liveTurn.gotOutput = true;
            if (this.thread().lastAccountId !== accountId) this.patch({ lastAccountId: accountId });
          }
          break;
        case 'session-init': {
          const patch: Partial<Thread> = { sdkSessionId: signal.sessionId };
          if (signal.model) patch.resolvedModel = signal.model;
          this.patch(patch);
          if (signal.cliVersion) this.deps.onCliVersion?.(signal.cliVersion);
          this.deps.onSessionInit?.();
          break;
        }
        case 'rate-limit':
          this.deps.usage.reportRateLimit(accountId, signal.info);
          if (liveTurn) liveTurn.lastRateLimit = signal.info;
          reported = true;
          break;
        case 'overage':
          // Billing (extra usage) in use: rejectedUntil.overage excludes the account from the next turn.
          if (!reported) this.deps.usage.reportRateLimit(accountId, signal.info);
          reported = true;
          break;
        case 'rate-limit-hit':
          if (!reported) this.deps.usage.reportRateLimit(accountId, { status: 'rejected' });
          reported = true;
          if (liveTurn) this.hitTurn(liveTurn, 'rate_limited');
          break;
        case 'auth-failed':
          this.deps.usage.markAuthFailed(accountId);
          if (liveTurn) this.hitTurn(liveTurn, 'auth');
          break;
      }
    }

    for (const event of events) {
      if (event.type === 'turn-end') continue; // turn-end is emitted by finishTurn
      if (event.type === 'text-delta') {
        this.emitEvent({ ...event, itemId: `${active.tag}:${event.itemId}` });
      } else if (event.type === 'item-upsert') {
        this.emitItem({ ...event.item, id: `${active.tag}:${event.item.id}` } as ChatItem);
      } else {
        this.emitEvent(event);
      }
    }

    if (msg.type === 'result') this.flushPartial(active);

    // `result` ends the turn unless a rate-limit/auth rejection already ended it (retry path wins).
    if (msg.type === 'result' && liveTurn && !liveTurn.ended) {
      if (liveTurn.reason === 'interrupted') {
        this.endTurn(liveTurn, 'interrupted');
      } else {
        if (msg.is_error) this.reportError(resultErrorText(msg));
        this.endTurn(liveTurn, msg.is_error ? 'error' : undefined);
      }
    }
  }

  /** Finalize a streamed-but-unfinished assistant text as an item (persisted) and reset streaming state. */
  private flushPartial(active: ActiveQuery): void {
    const { streamingItemId, streamingText } = active.reducer;
    if (streamingItemId === null && streamingText === '') return;
    active.reducer = { ...active.reducer, streamingItemId: null, streamingText: '' };
    if (streamingItemId && streamingText) {
      active.flushedPartialId = streamingItemId;
      this.emitItem({
        type: 'assistant-text',
        id: `${active.tag}:${streamingItemId}`,
        text: streamingText,
        createdAt: this.deps.now(),
      });
    }
  }

  private hitTurn(turn: TurnState, reason: TurnEndReason): void {
    this.endTurn(turn, reason);
    turn.active.q.interrupt().catch((err: unknown) => this.deps.log('[session] interrupt after rejection failed', err));
  }

  private endTurn(turn: TurnState, reason: TurnEndReason | undefined): void {
    if (turn.ended) return;
    turn.ended = true;
    turn.reason = reason;
    turn.resolve();
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    const minutes = this.deps.store.get().settings.idleCloseMinutes;
    if (!(minutes > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.busy || this.thread().status === 'running') return;
      this.work = this.closeQuery().catch((err: unknown) => this.deps.log('[session] idle close failed', err));
    }, minutes * MINUTE_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
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

  private patch(patch: Partial<Thread>): void {
    const thread = this.deps.store.patchThread(this.threadId, patch);
    this.deps.broadcaster.emit('thread:updated', { ...thread });
  }

  /** patch() for error paths: the thread may already be deleted. */
  private safePatch(patch: Partial<Thread>): void {
    try {
      this.patch(patch);
    } catch (err) {
      this.deps.log('[session] thread patch failed', err);
    }
  }

  private newId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  private emitEvent(event: ChatEvent): void {
    this.deps.broadcaster.emit('chat:event', { threadId: this.threadId, event });
  }

  private emitItem(item: ChatItem): void {
    this.emitEvent({ type: 'item-upsert', item });
    this.deps.threadLog
      .append(this.threadId, item)
      .catch((err: unknown) => this.deps.log('[session] thread log append failed', err));
  }

  private notice(level: SystemNoticeItem['level'], text: string): void {
    this.emitItem({ type: 'notice', id: this.newId('notice'), level, text, createdAt: this.deps.now() });
  }

  /**
   * `error` ChatEvent (the renderer shows it as a notice) + the same text persisted as an error notice,
   * so it survives a history reload without being rendered twice live.
   */
  private reportError(message: string): void {
    if (this.closed) return;
    this.emitEvent({ type: 'error', message });
    const item: SystemNoticeItem = { type: 'notice', id: this.newId('error'), level: 'error', text: message, createdAt: this.deps.now() };
    this.deps.threadLog
      .append(this.threadId, item)
      .catch((err: unknown) => this.deps.log('[session] thread log append failed', err));
  }
}

function hasTextBlock(msg: SDKMessage): boolean {
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content) && content.some((b) => (b as { type?: unknown } | null)?.type === 'text');
}

function isTextDelta(msg: SDKMessage): boolean {
  if (msg.type !== 'stream_event') return false;
  const event = (msg as { event?: { type?: unknown; delta?: { type?: unknown } } }).event;
  return event?.type === 'content_block_delta' && event.delta?.type === 'text_delta';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Message body of an `is_error` result (success-subtype `result` text, or the error subtype's `errors`). */
function resultErrorText(msg: Extract<SDKMessage, { type: 'result' }>): string {
  const m = msg as unknown as { subtype?: string; result?: unknown; errors?: unknown };
  if (typeof m.result === 'string' && m.result.trim()) return m.result.trim();
  if (Array.isArray(m.errors)) {
    const text = m.errors.filter((e): e is string => typeof e === 'string' && e.trim() !== '').join('\n');
    if (text) return text;
  }
  return `Claude Code 오류 (${m.subtype ?? 'unknown'}).`;
}
