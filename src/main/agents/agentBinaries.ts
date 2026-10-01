// Resolves the bundled codex-acp adapter, the installed Codex engine (`codex app-server`, found on this Mac) and the
// user's `hermes` (plan 3.2). Every filesystem / env / process access goes through injected seams so tests never
// touch the real home or run a real binary.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** Oldest `codex-cli` the codex-acp 2.x adapter is used with (older engines lack the app-server API it speaks). */
export const CODEX_MIN_VERSION = '0.150.0';
const VERSION_TIMEOUT_MS = 15_000;

/** A Codex CLI found on this Mac (`codex --version` -> `codex-cli X.Y.Z`). */
export interface CodexEngine {
  path: string;
  version: string;
}

export type CodexVersionProbe = (path: string) => Promise<string | null>;

/** Engine file check: `ok` carries the realpath to run (CODEX_PATH); otherwise a user-facing reason. */
export type EngineInspection = { ok: true; path: string } | { ok: false; error: string };
export type InspectEngineFn = (path: string) => EngineInspection;

export interface EngineFileDeps {
  realpath?: (path: string) => string;
  stat?: (path: string) => { isFile(): boolean; mode: number; uid: number };
  /** exists + X_OK. */
  isExecutable?: (path: string) => boolean;
  /** Current user id (`process.getuid`). */
  uid?: () => number;
}

export interface AgentBinariesDeps {
  homedir?: () => string;
  /** Process PATH. */
  pathEnv?: string;
  /** Login-shell env (ShellEnv.baseEnv), consulted last. */
  loginEnv?: () => Record<string, string>;
  /** exists + X_OK. */
  isExecutable?: (path: string) => boolean;
  /** Packaged app: `process.resourcesPath` (extraResources `bin/codex-acp`). */
  resourcesPath?: string;
  /** Dev / test: the project root (`build/bin/codex-acp`, made by scripts/build-codex-acp.mjs). */
  appRoot?: string;
  /** Settings > Codex 실행 파일 경로 ('' = auto-detect). */
  codexOverride?: () => string;
  /** `codex --version` stdout (null = failed). Defaults to a run under a throwaway HOME / CODEX_HOME. */
  codexVersion?: CodexVersionProbe;
  /** Engine file check (realpath / regular file / not group- or world-writable / owned by root or me). */
  inspectEngine?: InspectEngineFn;
}

export interface AgentBinaries {
  /** The bundled codex-acp adapter binary. */
  resolveCodexAcp(): string | null;
  /** Detects the Codex engine (cached until `invalidate`); null = none installed at or above CODEX_MIN_VERSION. */
  resolveCodex(): Promise<CodexEngine | null>;
  /** The last `resolveCodex` result (sync; null until it has run, while it re-runs, or when nothing was found). */
  codexEngine(): CodexEngine | null;
  /** Why the Settings override could not be used (null = no override or it is fine). */
  codexEngineError(): string | null;
  /** Re-checks an engine file right before a spawn: its realpath, or null when it no longer passes. */
  verifyCodexEngine(path: string): string | null;
  /** Settings override validation: the same file checks and `--version` probe as detection. */
  checkCodexPath(path: string): Promise<{ ok: true; engine: CodexEngine } | { ok: false; error: string }>;
  resolveHermes(): string | null;
  /** Drops the cached results (`agents:recheck`, settings change). */
  invalidate(): void;
}

function defaultIsExecutable(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `codex-cli 0.159.2` -> `0.159.2` (also tolerates a bare version / prerelease suffix). */
export function parseCodexVersion(stdout: string): string | null {
  const m = /(?:^|\s)(?:codex-cli\s+)?v?(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?\s*$/m.exec(stdout.trim());
  return m?.[1] ?? null;
}

/** Numeric x.y.z comparison. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The engine file must be a regular executable file (after resolving symlinks), not group- or world-writable, and
 * owned by root or the current user: anything else could be swapped by another user / process.
 */
export function inspectEngineFile(path: string, deps: EngineFileDeps = {}): EngineInspection {
  if (!isAbsolute(path)) return { ok: false, error: '절대 경로를 입력하세요' };
  let real: string;
  let st: { isFile(): boolean; mode: number; uid: number };
  try {
    real = (deps.realpath ?? realpathSync)(path);
    st = (deps.stat ?? statSync)(real);
  } catch {
    return { ok: false, error: '파일을 찾을 수 없습니다' };
  }
  if (!st.isFile()) return { ok: false, error: '일반 파일이 아닙니다' };
  if (!(deps.isExecutable ?? defaultIsExecutable)(real)) return { ok: false, error: '실행 가능한 파일이 아닙니다' };
  if ((st.mode & 0o022) !== 0) return { ok: false, error: '그룹 또는 다른 사용자가 수정할 수 있는 파일은 사용할 수 없습니다' };
  const me = (deps.uid ?? (() => process.getuid?.() ?? -1))();
  if (st.uid !== 0 && st.uid !== me) return { ok: false, error: '소유자가 root 또는 현재 사용자가 아닌 파일은 사용할 수 없습니다' };
  return { ok: true, path: real };
}

/**
 * `<codex> --version` with a minimal env: PATH (the login shell's, so an npm `#!/usr/bin/env node` codex finds node;
 * default /usr/bin:/bin) and a throwaway HOME / CODEX_HOME (the user's ~/.codex is never touched).
 */
export const createCodexVersionProbe =
  (pathEnv: () => string | undefined = () => undefined): CodexVersionProbe =>
  (path) =>
    new Promise((resolve) => {
    let home: string;
    try {
      home = mkdtempSync(join(tmpdir(), 'hopecode-codex-ver-'));
    } catch {
      resolve(null);
      return;
    }
    const env = { PATH: pathEnv() || '/usr/bin:/bin', HOME: home, CODEX_HOME: join(home, '.codex') };
    execFile(path, ['--version'], { env, cwd: home, timeout: VERSION_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      rmSync(home, { recursive: true, force: true });
      resolve(err ? null : stdout);
    });
  });

export const runCodexVersion: CodexVersionProbe = createCodexVersionProbe();

/**
 * Checks one Codex executable: the file checks (inspectEngineFile) first, then `codex-cli X.Y.Z` >= CODEX_MIN_VERSION.
 * The engine path is the realpath (what CODEX_PATH gets).
 */
export async function checkCodexEngine(
  input: string,
  deps: Pick<AgentBinariesDeps, 'inspectEngine' | 'codexVersion'> = {},
): Promise<{ ok: true; engine: CodexEngine } | { ok: false; error: string }> {
  const inspected = (deps.inspectEngine ?? inspectEngineFile)(input);
  if (!inspected.ok) return inspected;
  const path = inspected.path;
  const out = await (deps.codexVersion ?? runCodexVersion)(path);
  const version = out === null ? null : parseCodexVersion(out);
  if (!version) return { ok: false, error: '`--version`에서 codex-cli 버전을 읽지 못했습니다' };
  if (compareVersions(version, CODEX_MIN_VERSION) < 0) {
    return { ok: false, error: `codex-cli ${version}은(는) 지원하지 않습니다 (${CODEX_MIN_VERSION} 이상 필요)` };
  }
  return { ok: true, engine: { path, version } };
}

export function createAgentBinaries(deps: AgentBinariesDeps = {}): AgentBinaries {
  const home = deps.homedir ?? homedir;
  const isExec = deps.isExecutable ?? defaultIsExecutable;
  const inspectEngine = deps.inspectEngine ?? ((path: string) => inspectEngineFile(path));
  const codexVersion = deps.codexVersion ?? createCodexVersionProbe(() => deps.loginEnv?.()['PATH']);
  const check = (path: string) => checkCodexEngine(path, { inspectEngine, codexVersion });
  let codexAcp: string | null | undefined;
  let engine: Promise<CodexEngine | null> | undefined;
  let engineResult: CodexEngine | null = null;
  let engineError: string | null = null;
  let hermes: string | null | undefined;

  function findOnPath(pathEnv: string | undefined, name: string): string | null {
    for (const dir of (pathEnv ?? '').split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (isExec(candidate)) return candidate;
    }
    return null;
  }

  /** Detection order: ChatGPT.app -> login-shell PATH -> common install dirs (deduplicated). */
  function codexCandidates(): string[] {
    const appBundle = join('ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex');
    const list = [
      join('/Applications', appBundle),
      join(home(), 'Applications', appBundle),
      findOnPath(deps.loginEnv?.()['PATH'], 'codex') ?? '',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      join(home(), '.local', 'bin', 'codex'),
    ];
    return [...new Set(list.filter((p) => p !== '' && isExec(p)))];
  }

  /** A Settings override is the only candidate: when it fails, no engine (never a silent fallback to detection). */
  async function detectCodex(): Promise<{ engine: CodexEngine | null; error: string | null }> {
    const override = deps.codexOverride?.().trim() ?? '';
    if (override !== '') {
      const checked = await check(override);
      return checked.ok ? { engine: checked.engine, error: null } : { engine: null, error: checked.error };
    }
    let best: CodexEngine | null = null;
    for (const path of codexCandidates()) {
      const checked = await check(path);
      if (!checked.ok) continue;
      // Highest version wins; on a tie the earlier (higher-priority) candidate stays.
      if (!best || compareVersions(checked.engine.version, best.version) > 0) best = checked.engine;
    }
    return { engine: best, error: null };
  }

  return {
    resolveCodexAcp() {
      if (codexAcp === undefined) {
        const candidates = [
          deps.resourcesPath ? join(deps.resourcesPath, 'bin', 'codex-acp') : null,
          deps.appRoot ? join(deps.appRoot, 'build', 'bin', 'codex-acp') : null,
        ];
        codexAcp = candidates.find((p): p is string => p !== null && isExec(p)) ?? null;
      }
      return codexAcp;
    },
    resolveCodex() {
      if (!engine) {
        const run: Promise<CodexEngine | null> = detectCodex().then((r) => {
          // An invalidate() during detection makes this result stale; the newer run sets the value.
          if (engine === run) {
            engineResult = r.engine;
            engineError = r.error;
          }
          return r.engine;
        });
        engine = run;
      }
      return engine;
    },
    codexEngine() {
      return engineResult;
    },
    codexEngineError() {
      return engineError;
    },
    verifyCodexEngine(path) {
      const inspected = inspectEngine(path);
      return inspected.ok ? inspected.path : null;
    },
    checkCodexPath(path) {
      return check(path);
    },
    resolveHermes() {
      if (hermes === undefined) {
        hermes =
          findOnPath(deps.pathEnv ?? process.env['PATH'], 'hermes') ??
          (isExec(join(home(), '.local', 'bin', 'hermes')) ? join(home(), '.local', 'bin', 'hermes') : null) ??
          findOnPath(deps.loginEnv?.()['PATH'], 'hermes');
      }
      return hermes;
    },
    invalidate() {
      codexAcp = undefined;
      engine = undefined;
      // Never hand out the previous engine while the next detection runs (callers await resolveCodex()).
      engineResult = null;
      engineError = null;
      hermes = undefined;
    },
  };
}
