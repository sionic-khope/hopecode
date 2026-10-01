// One ACP agent process + SDK client connection (plan 2.3 AcpConnection, 2.7). One per AcpRunner connection.
// The agent runs in its own process group (`detached`) so closing kills its children too (`kill(-pid)`).
// The SDK has no request timeout: every request is raced against a timer, the caller's signal and process exit.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  AgentRequestMethod,
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  ClientConnection,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { redact } from '../../core/redact';
import { ACP_INITIALIZE_TIMEOUT_MS, ACP_KILL_GRACE_MS } from '../../shared/constants';
import type { AcpLaunchSpec } from '../contracts';

/** Bytes of stderr kept in memory (ring buffer). */
const STDERR_RING_BYTES = 64 * 1024;
/** Lines of (redacted) stderr shown in an error notice. */
const STDERR_TAIL_LINES = 20;
/** Chars of one stderr line kept in the tail (bounds the redaction work, plan L-1). */
const STDERR_LINE_MAX = 4 * 1024;
/** Whole close budget on the app-quit path (QUIT_DISPOSE_TIMEOUT_MS covers every runner in parallel). */
export const ACP_DISPOSE_BUDGET_MS = 1_000;
/** SIGTERM -> SIGKILL grace for children left in the group after the leader exited. */
const EXIT_GROUP_GRACE_MS = 500;
/** `session/close` budget on the normal close path. */
const SESSION_CLOSE_TIMEOUT_MS = 3_000;

export class AcpTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`ACP ${method} timed out after ${timeoutMs}ms`);
    this.name = 'AcpTimeoutError';
  }
}

export class AcpAbortedError extends Error {
  constructor(readonly method: string) {
    super(`ACP ${method} aborted`);
    this.name = 'AcpAbortedError';
  }
}

/** The agent process is gone (exit, crash, stdin EPIPE). `stderrTail` is already redacted. */
export class AcpProcessExitedError extends Error {
  constructor(
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderrTail: string,
  ) {
    super(`ACP agent exited (${signal ?? `code ${code ?? 'unknown'}`})`);
    this.name = 'AcpProcessExitedError';
  }
}

/** The executable could not be started (ENOENT / EACCES / EPERM / no pid). */
export class AcpSpawnError extends Error {
  constructor(readonly code: string) {
    super(`ACP agent could not be started: ${code}`);
    this.name = 'AcpSpawnError';
  }
}

export class AcpProtocolVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`unsupported ACP protocol version: ${String(version)}`);
    this.name = 'AcpProtocolVersionError';
  }
}

export interface AcpConnectionHandlers {
  /**
   * `session/update`. Must run synchronously to completion (no await before state is updated): the SDK delivers
   * every update an agent sent before a response ahead of that response's resolution only for sync handlers.
   */
  onUpdate(params: SessionNotification): void;
  /** `session/request_permission`; `signal` aborts when the agent cancels the request or the connection closes. */
  onPermission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Sends a signal to a process group (`-pid`); false when it is already gone. Injected in tests. */
export type KillGroupFn = (pid: number, signal: NodeJS.Signals) => boolean;

export interface AcpConnectionOptions {
  spec: AcpLaunchSpec;
  /** Process working directory when `spec.cwd` is not set. */
  cwd: string;
  handlers: AcpConnectionHandlers;
  appVersion: string;
  spawn?: SpawnFn;
  killGroup?: KillGroupFn;
  /** SIGTERM -> SIGKILL grace on the normal close path (default ACP_KILL_GRACE_MS). */
  killGraceMs?: number;
  log?: (message: string, err?: unknown) => void;
}

export interface AcpExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const defaultKillGroup: KillGroupFn = (pid, signal) => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
};

export class AcpConnection {
  readonly child: ChildProcess;
  private readonly conn: ClientConnection | null;
  private readonly killGroup: KillGroupFn;
  private readonly log: (message: string, err?: unknown) => void;
  private stderrBuf = '';
  private exitInfo: AcpExitInfo | null = null;
  private failure: Error | null = null;
  private readonly exitPromise: Promise<AcpExitInfo>;
  /** Rejects once the process is gone or failed to start (never unhandled). */
  private readonly gone: Promise<never>;
  private markGone!: (err: Error) => void;
  private initResponse: InitializeResponse | null = null;
  /** Set by close() / kill(): stdout read errors after that are the expected teardown of the web stream. */
  private closing = false;
  /** The leftover group was signalled at exit (never again: the pid may be reused). */
  private groupSignalled = false;

  constructor(private readonly opts: AcpConnectionOptions) {
    this.killGroup = opts.killGroup ?? defaultKillGroup;
    this.log = opts.log ?? (() => {});
    this.gone = new Promise<never>((_, reject) => {
      this.markGone = reject;
    });
    this.gone.catch(() => {});

    let resolveExit!: (info: AcpExitInfo) => void;
    this.exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });

    const spawnFn = opts.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(opts.spec.command, opts.spec.args, {
        cwd: opts.spec.cwd ?? opts.cwd,
        env: opts.spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      // Synchronous spawn failures (invalid args) behave like an async spawn error.
      child = deadChild();
      this.fail(new AcpSpawnError(errCode(err)));
      resolveExit({ code: null, signal: null });
      this.exitInfo = { code: null, signal: null };
      this.child = child;
      this.conn = null;
      return;
    }
    this.child = child;

    child.on('error', (err) => {
      // Spawn failure (ENOENT / EACCES / EPERM) or a failed kill; the former never emits 'exit'.
      if (child.pid === undefined) {
        this.fail(new AcpSpawnError(errCode(err)));
        if (!this.exitInfo) {
          this.exitInfo = { code: null, signal: null };
          resolveExit(this.exitInfo);
        }
      } else {
        this.log('[acp] child process error', errCode(err));
      }
    });
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.signalLeftoverGroup(child.pid);
      this.fail(new AcpProcessExitedError(code, signal, this.stderrTail()));
      resolveExit(this.exitInfo);
    });
    // EPIPE / ERR_STREAM_DESTROYED on stdin = the agent is gone; unhandled it would crash the main process.
    child.stdin?.on('error', (err) => {
      this.log('[acp] agent stdin error', errCode(err));
      this.fail(new AcpProcessExitedError(null, null, this.stderrTail()));
      this.kill();
    });
    child.stdout?.on('error', (err) => {
      if (!this.closing) this.log('[acp] agent stdout error', errCode(err));
    });
    // stderr is always drained (Hermes logs a lot; a full pipe would block the agent).
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuf += chunk.toString('utf8');
      if (this.stderrBuf.length > STDERR_RING_BYTES) this.stderrBuf = this.stderrBuf.slice(-STDERR_RING_BYTES);
    });
    child.stderr?.on('error', () => {});

    if (!child.stdin || !child.stdout) {
      this.conn = null;
      this.fail(new AcpSpawnError('ENOSTDIO'));
      return;
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    this.conn = acp
      .client({ name: 'hopecode' })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        opts.handlers.onUpdate(ctx.params);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        opts.handlers.onPermission(ctx.params, ctx.signal),
      )
      .connect(stream);
    // stdout usually ends before 'exit': give the exit event a moment so the error carries the exit code.
    const onClosed = () =>
      void within(this.exitPromise, 500).then(() =>
        this.fail(new AcpProcessExitedError(this.exitInfo?.code ?? null, this.exitInfo?.signal ?? null, this.stderrTail())),
      );
    this.conn.closed.then(onClosed, onClosed);
  }

  /** `initialize` response (null before initialize succeeded). */
  get init(): InitializeResponse | null {
    return this.initResponse;
  }

  /** Resolves when the process exited (or never started). */
  get exited(): Promise<AcpExitInfo> {
    return this.exitPromise;
  }

  /** True once the process exited, failed to start or the connection closed. */
  get isGone(): boolean {
    return this.failure !== null;
  }

  /** `initialize` with protocol v1; any other version closes the connection. */
  async initialize(signal?: AbortSignal, timeoutMs = ACP_INITIALIZE_TIMEOUT_MS): Promise<InitializeResponse> {
    const res = await this.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'hopecode', version: this.opts.appVersion },
      },
      timeoutMs,
      signal,
    );
    if (res.protocolVersion !== acp.PROTOCOL_VERSION) throw new AcpProtocolVersionError(res.protocolVersion);
    this.initResponse = res;
    return res;
  }

  /**
   * Request with a timeout (`timeoutMs` null = none, e.g. `session/prompt`). Timeout / abort send
   * `$/cancel_request` and reject at once; process exit rejects with AcpProcessExitedError.
   */
  request<M extends AgentRequestMethod>(
    method: M,
    params: AgentRequestParamsByMethod[M],
    timeoutMs: number | null,
    signal?: AbortSignal,
  ): Promise<AgentRequestResponsesByMethod[M]> {
    if (this.failure || !this.conn) return Promise.reject(this.failure ?? new AcpSpawnError('ENOSTDIO'));
    if (signal?.aborted) return Promise.reject(new AcpAbortedError(method));
    const cancel = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const stop = new Promise<never>((_, reject) => {
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          cancel.abort();
          reject(new AcpTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      if (signal) {
        onAbort = () => {
          cancel.abort();
          reject(new AcpAbortedError(method));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    const sent = this.conn.agent.request(method, params, { cancellationSignal: cancel.signal });
    return Promise.race([sent, stop, this.gone])
      .catch(async (err: unknown) => {
        // The SDK may reject with its own "connection closed" before the exit event: report the exit instead.
        if (!(err instanceof AcpTimeoutError || err instanceof AcpAbortedError) && this.conn?.signal.aborted) {
          await within(this.exitPromise, 500);
          if (this.failure) throw this.failure;
        }
        throw err;
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
        sent.catch(() => {});
      });
  }

  /** Fire-and-forget notification (`session/cancel`). Never throws. */
  notify(method: 'session/cancel', params: { sessionId: string }): void {
    if (this.failure || !this.conn) return;
    this.conn.agent.notify(method, params).catch((err: unknown) => this.log('[acp] notify failed', errCode(err)));
  }

  /** Redacted last lines of the agent's stderr (for error notices). */
  stderrTail(): string {
    const lines = this.stderrBuf.split('\n').filter((l) => l.trim() !== '');
    const tail = lines.slice(-STDERR_TAIL_LINES).map((l) => (l.length > STDERR_LINE_MAX ? `${l.slice(0, STDERR_LINE_MAX)}…` : l));
    return redact(tail.join('\n'));
  }

  /**
   * Graceful stop: `session/close` when supported and not on the quit path -> close the connection -> stdin end
   * -> SIGTERM to the group -> grace -> SIGKILL. Resolves once the process exited.
   * `dispose`: skip `session/close`, whole budget ACP_DISPOSE_BUDGET_MS.
   */
  async close(opts: { sessionId?: string | null; dispose?: boolean } = {}): Promise<void> {
    const started = Date.now();
    const budget = opts.dispose ? ACP_DISPOSE_BUDGET_MS : null;
    if (
      !opts.dispose &&
      opts.sessionId &&
      !this.failure &&
      this.initResponse?.agentCapabilities?.sessionCapabilities?.close
    ) {
      await this.request(acp.methods.agent.session.close, { sessionId: opts.sessionId }, SESSION_CLOSE_TIMEOUT_MS).catch(
        (err: unknown) => this.log('[acp] session/close failed', errName(err)),
      );
    }
    this.closing = true;
    this.conn?.close();
    try {
      this.child.stdin?.end();
    } catch {
      // Already destroyed.
    }
    const pid = this.child.pid;
    if (pid === undefined) return;
    const grace = budget !== null ? Math.max(0, budget - (Date.now() - started) - 200) : (this.opts.killGraceMs ?? ACP_KILL_GRACE_MS);
    // The leader exited: its leftover group was already signalled at exit (signalLeftoverGroup).
    if (this.exitInfo) return;
    this.killGroup(pid, 'SIGTERM');
    if (await within(this.exitPromise, grace)) return;
    this.killGroup(pid, 'SIGKILL');
    if (budget !== null) await within(this.exitPromise, Math.max(0, budget - (Date.now() - started)));
    else await this.exitPromise;
  }

  /** SIGKILL the whole group now (no wait), while the leader lives (after exit the pid may be reused). */
  kill(): void {
    this.closing = true;
    this.conn?.close();
    const pid = this.child.pid;
    if (pid !== undefined && !this.exitInfo) this.killGroup(pid, 'SIGKILL');
  }

  /**
   * Children the leader left in its group: TERM now, KILL after a short grace (ESRCH = none left). Only here, once:
   * after that the pid (and group id) may be reused by an unrelated process, so close() / kill() never signal it.
   */
  private signalLeftoverGroup(pid: number | undefined): void {
    if (pid === undefined || this.groupSignalled) return;
    this.groupSignalled = true;
    if (!this.killGroup(pid, 'SIGTERM')) return;
    setTimeout(() => this.killGroup(pid, 'SIGKILL'), EXIT_GROUP_GRACE_MS).unref?.();
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.markGone(err);
  }
}

/** True when `p` settles within `ms`, else false; the timer is cleared either way (no dangling timers). */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([p.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : errName(err);
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/** Placeholder for a spawn that threw synchronously (never started). */
function deadChild(): ChildProcess {
  return { pid: undefined, stdin: null, stdout: null, stderr: null, on() {} } as unknown as ChildProcess;
}
