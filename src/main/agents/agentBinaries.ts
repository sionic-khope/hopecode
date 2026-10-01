// Resolves the bundled codex-acp native binary and the user's `hermes` (plan 3.2). Every filesystem / env access
// goes through injected seams so tests never touch the real home.
import { accessSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { unpackAsarPath } from '../claudeBinary';

const requireFromHere = createRequire(import.meta.url);

export interface AgentBinariesDeps {
  arch?: NodeJS.Architecture;
  require?: NodeRequire;
  homedir?: () => string;
  /** Process PATH. */
  pathEnv?: string;
  /** Login-shell env (ShellEnv.baseEnv), consulted last. */
  loginEnv?: () => Record<string, string>;
  /** exists + X_OK. */
  isExecutable?: (path: string) => boolean;
}

export interface AgentBinaries {
  resolveCodexAcp(): string | null;
  resolveHermes(): string | null;
  /** Drops the cached results (`agents:recheck`). */
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

export function createAgentBinaries(deps: AgentBinariesDeps = {}): AgentBinaries {
  const arch = deps.arch ?? process.arch;
  const req = deps.require ?? requireFromHere;
  const home = deps.homedir ?? homedir;
  const isExec = deps.isExecutable ?? defaultIsExecutable;
  let codex: string | null | undefined;
  let hermes: string | null | undefined;

  function findOnPath(pathEnv: string | undefined, name: string): string | null {
    for (const dir of (pathEnv ?? '').split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (isExec(candidate)) return candidate;
    }
    return null;
  }

  function fromPlatformPackage(): string | null {
    try {
      const pkgJson = req.resolve(`@zed-industries/codex-acp-darwin-${arch}/package.json`);
      const bin = unpackAsarPath(join(dirname(pkgJson), 'bin', 'codex-acp'));
      return isExec(bin) ? bin : null;
    } catch {
      return null;
    }
  }

  return {
    resolveCodexAcp() {
      if (codex === undefined) {
        codex = fromPlatformPackage() ?? findOnPath(deps.loginEnv?.()['PATH'], 'codex-acp');
      }
      return codex;
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
      codex = undefined;
      hermes = undefined;
    },
  };
}
