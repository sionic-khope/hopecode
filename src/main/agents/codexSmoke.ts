// HOPECODE_SMOKE Codex check (packaged and dev): the bundled codex-acp adapter (`--version`), the installed Codex engine
// and an offline `initialize` under a temporary HOME / CODEX_HOME. The adapter starts the real `codex app-server`, so
// the temporary CODEX_HOME gets a config.toml forcing Codex's credential stores to `file` (inside that directory): the
// user's ~/.codex is not used and the login Keychain entries are not consulted. No session is opened, nothing is sent
// to a model. No Codex engine on this Mac -> a warning, not a failure.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpConnection, type AcpConnectionOptions } from '../acp/acpConnection';
import type { AgentBinaries } from './agentBinaries';

/** Codex config keys (codex-cli >= 0.150): keep CLI auth and MCP OAuth credentials in CODEX_HOME, not the Keychain. */
export const SMOKE_CODEX_CONFIG_TOML = 'cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n';

/** `agentInfo.name` of @agentclientprotocol/codex-acp 2.x. */
export const CODEX_ACP_AGENT_NAME = '@agentclientprotocol/codex-acp';

export interface CodexSmokeDeps {
  binaries: Pick<AgentBinaries, 'resolveCodexAcp' | 'resolveCodex'>;
  /** Packaged app: the adapter must live under this directory (Contents/Resources/bin). */
  requiredDir?: string;
  appVersion: string;
  /** Tests inject a connection factory; defaults to a real AcpConnection. */
  connect?: (opts: AcpConnectionOptions) => AcpConnection;
  log: (line: string) => void;
  error: (line: string, err?: unknown) => void;
}

export async function codexAcpSmoke(deps: CodexSmokeDeps): Promise<boolean> {
  const bin = deps.binaries.resolveCodexAcp();
  if (!bin) {
    deps.error('[smoke] codex-acp binary not found or not executable');
    return false;
  }
  if (deps.requiredDir && !bin.startsWith(`${deps.requiredDir}/`)) {
    deps.error(`[smoke] packaged codex-acp is not under ${deps.requiredDir}: ${bin}`);
    return false;
  }
  const home = mkdtempSync(join(tmpdir(), 'hopecode-smoke-codex-'));
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { mode: 0o700 });
  writeFileSync(join(codexHome, 'config.toml'), SMOKE_CODEX_CONFIG_TOML, { mode: 0o600 });
  const env = { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome };
  try {
    const adapterVersion = await new Promise<string>((resolve, reject) => {
      execFile(bin, ['--version'], { timeout: 15_000, env, cwd: home }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
    });
    deps.log(`[smoke] codex-acp binary ok (${bin}) version: ${adapterVersion}`);
    const engine = await deps.binaries.resolveCodex();
    if (!engine) {
      deps.log('[smoke] WARN codex engine not found (ChatGPT.app / codex CLI); initialize skipped');
      return true;
    }
    deps.log(`[smoke] codex engine ok (${engine.path}) codex-cli ${engine.version}`);
    const opts: AcpConnectionOptions = {
      spec: { command: bin, args: [], env: { ...env, CODEX_PATH: engine.path, INITIAL_AGENT_MODE: 'read-only', CODEX_CONFIG: '{}' } },
      cwd: home,
      appVersion: deps.appVersion,
      handlers: {
        onUpdate() {},
        onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      },
      log: (message) => deps.error(message),
    };
    const conn = deps.connect ? deps.connect(opts) : new AcpConnection(opts);
    try {
      const init = await conn.initialize(undefined, 20_000);
      const name = init.agentInfo?.name;
      if (name !== CODEX_ACP_AGENT_NAME) {
        deps.error(`[smoke] codex-acp initialize returned agent ${String(name)}`);
        return false;
      }
      deps.log(`[smoke] codex-acp initialize ok (${name} ${init.agentInfo?.version ?? '?'})`);
      return true;
    } finally {
      await conn.close({ dispose: true }).catch(() => {});
    }
  } catch (err) {
    deps.error('[smoke] codex-acp check failed', err);
    return false;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
