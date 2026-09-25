// OAuth login for one account config dir (plan 7.1):
// node-pty `<claude> auth login --claudeai` with childEnv({configDir}) -> on exit 0,
// `<claude> auth status --json` -> loggedIn && authMethod === 'claude.ai' -> email / subscriptionType.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ChildEnvInject } from '../../shared/types';

export interface PtyLike {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  kill(signal?: string): void;
}

export type SpawnPtyFn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyLike;

export type RunCommandFn = (
  file: string,
  args: string[],
  opts: { env: Record<string, string>; timeout: number },
) => Promise<{ code: number; stdout: string }>;

export interface LoginFlowDeps {
  claudePath: () => string;
  /** ShellEnv.childEnv — the only env source for the login pty and `auth status`. */
  childEnv: (inject: ChildEnvInject) => Record<string, string>;
  spawnPty?: SpawnPtyFn;
  runCommand?: RunCommandFn;
  /** Helper open of the OAuth URL printed by the CLI (shell.openExternal). */
  openExternal?: (url: string) => void;
}

export type LoginResult =
  | { ok: true; email: string | null; plan: string | null }
  | { ok: false; error: string };

export interface LoginSession {
  loginId: string;
  write(data: string): void;
  cancel(): void;
  done: Promise<LoginResult>;
}

const AUTH_STATUS_TIMEOUT_MS = 15_000;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const URL_RE = /https:\/\/[^\s"'<>]+/;

/** Lazy so tests / non-Electron runs never load the native module unless the default is used. */
export const nodePtySpawn: SpawnPtyFn = (file, args, opts) => {
  const req = createRequire(import.meta.url);
  const pty = req('node-pty') as typeof import('node-pty');
  return pty.spawn(file, args, opts);
};

export const execRunCommand: RunCommandFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { env: opts.env, timeout: opts.timeout, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: stdout ?? '' });
    });
  });

/** Parse `claude auth status --json`. */
export function parseAuthStatus(stdout: string): LoginResult {
  let s: unknown;
  try {
    s = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, error: 'Could not read `claude auth status` output.' };
  }
  if (typeof s !== 'object' || s === null) return { ok: false, error: 'Unexpected `claude auth status` output.' };
  const st = s as Record<string, unknown>;
  if (st.loggedIn !== true) return { ok: false, error: 'Login did not complete.' };
  if (st.authMethod !== 'claude.ai') {
    return { ok: false, error: `Unsupported auth method: ${String(st.authMethod)} (claude.ai subscription required).` };
  }
  return {
    ok: true,
    email: typeof st.email === 'string' ? st.email : null,
    plan: typeof st.subscriptionType === 'string' ? st.subscriptionType : null,
  };
}

export function startLoginFlow(
  deps: LoginFlowDeps,
  input: { loginId: string; configDir: string; onData: (data: string) => void; cols?: number; rows?: number },
): LoginSession {
  const spawnPty = deps.spawnPty ?? nodePtySpawn;
  const runCommand = deps.runCommand ?? execRunCommand;
  const claude = deps.claudePath();
  const env = deps.childEnv({ configDir: input.configDir });

  let cancelled = false;
  let settled = false;
  let urlOpened = false;
  let scanBuf = '';
  let resolveDone!: (r: LoginResult) => void;
  const done = new Promise<LoginResult>((r) => (resolveDone = r));
  const finish = (r: LoginResult): void => {
    if (settled) return;
    settled = true;
    resolveDone(r);
  };

  let pty: PtyLike;
  try {
    pty = spawnPty(claude, ['auth', 'login', '--claudeai'], {
      name: 'xterm-256color',
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      cwd: input.configDir,
      env,
    });
  } catch (err) {
    finish({ ok: false, error: `Failed to start claude: ${(err as Error).message}` });
    return { loginId: input.loginId, write: () => {}, cancel: () => {}, done };
  }

  pty.onData((data) => {
    input.onData(data);
    if (urlOpened || !deps.openExternal) return;
    scanBuf = (scanBuf + data).slice(-8192);
    const clean = scanBuf.replace(ANSI_RE, '');
    const m = URL_RE.exec(clean);
    // Wait for a delimiter after the URL so a chunk-split URL is not opened truncated.
    if (m && clean.length > m.index + m[0].length) {
      urlOpened = true;
      deps.openExternal(m[0]);
    }
  });

  pty.onExit(({ exitCode }) => {
    if (cancelled) return finish({ ok: false, error: 'cancelled' });
    if (exitCode !== 0) return finish({ ok: false, error: `claude auth login exited with code ${exitCode}` });
    runCommand(claude, ['auth', 'status', '--json'], { env, timeout: AUTH_STATUS_TIMEOUT_MS })
      .then(({ stdout }) => finish(parseAuthStatus(stdout)))
      .catch((err: unknown) => finish({ ok: false, error: `claude auth status failed: ${String(err)}` }));
  });

  return {
    loginId: input.loginId,
    write: (data) => {
      if (!settled) pty.write(data);
    },
    cancel: () => {
      if (settled) return;
      cancelled = true;
      try {
        pty.kill();
      } catch {
        // already exited
      }
      finish({ ok: false, error: 'cancelled' });
    },
    done,
  };
}
