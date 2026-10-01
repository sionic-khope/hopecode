// Hermes local login (plan 2.9.2): `hermes acp --version/--check`, `hermes auth list/status <provider>`, and an
// ACP `initialize` probe whose agent-type authMethod id is the active provider. The probe spawns a process, so it
// only runs when `opts.probe` is true (app start, user recheck).
import { spawn } from 'node:child_process';
import { parseHermesAuthList, parseHermesAuthStatus } from '../../../core/hermesAuthParse';
import type { LocalAuthInfo } from '../../../shared/types';
import { baseInfo, type DetectorDeps } from './detectorDeps';

const CMD_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 20_000;
/** stdout kept while waiting for the initialize answer (a noisy agent cannot grow it without bound). */
const PROBE_STDOUT_MAX = 1024 * 1024;

/** Returns the `authMethods` of an ACP initialize response, or null when the probe failed. */
export type InitializeProbe = (
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<{ id: string; type?: string }[] | null>;

export const spawnInitializeProbe: InitializeProbe = (command, args, env, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    let buf = '';
    // Own process group: the probe and anything it started are SIGKILLed together.
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const finish = (value: { id: string; type?: string }[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // ESRCH: already gone
        }
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', () => undefined); // always drain (plan 0.3)
    child.stdout.on('data', (d: Buffer) => {
      if (settled) return;
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as { id?: unknown; result?: { authMethods?: unknown } };
          if (msg.id === 1) {
            const methods = msg.result?.authMethods;
            finish(
              Array.isArray(methods)
                ? methods.flatMap((m: unknown) => {
                    const o = m as { id?: unknown; type?: unknown };
                    return typeof o?.id === 'string'
                      ? [{ id: o.id, ...(typeof o.type === 'string' ? { type: o.type } : {}) }]
                      : [];
                  })
                : null,
            );
          }
        } catch {
          // not a JSON line (log noise)
        }
      }
      // An unterminated line past the cap: give up instead of buffering without bound.
      if (buf.length > PROBE_STDOUT_MAX) finish(null);
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n',
    );
  });

export interface HermesDetectorDeps extends DetectorDeps {
  /** `agentBinaries.resolveHermes` (null = not installed). */
  hermesPath: () => string | null;
  /** Login-shell env for the child processes. */
  env: () => Record<string, string>;
  probeInitialize?: InitializeProbe;
}

export async function detectHermes(
  deps: HermesDetectorDeps,
  opts: { probe: boolean; prev?: LocalAuthInfo | null },
): Promise<LocalAuthInfo> {
  const bin = deps.hermesPath();
  const info = baseInfo('hermes', bin ?? '~/.local/bin/hermes', deps.now());
  if (!bin) return { ...info, state: 'not-installed', detail: 'hermes-not-found' };
  const env = deps.env();
  const run = (args: string[]) => deps.runCommand(bin, args, { env, timeout: CMD_TIMEOUT_MS });

  const ver = await run(['acp', '--version']);
  if (ver.code !== 0) return { ...info, state: 'error', detail: 'version-check-failed' };
  const version = ver.stdout.trim().split(/\s+/)[0] || null;
  const withVer = { ...info, version };
  const check = await run(['acp', '--check']);
  if (check.code !== 0) return { ...withVer, state: 'error', detail: 'acp-check-failed' };

  const list = await run(['auth', 'list']);
  const providers = list.code === 0 ? parseHermesAuthList(list.stdout) : [];
  const statuses = await Promise.all(providers.map((p) => run(['auth', 'status', p.id])));
  const loggedInProviders = providers.filter((_, i) => parseHermesAuthStatus((statuses[i] as { stdout: string }).stdout) === true);
  const common = { ...withVer, providers };

  if (!opts.probe && opts.prev && opts.prev.agent === 'hermes' && opts.prev.state !== 'not-installed') {
    // Probe result stays cached; only binary/version/providers refresh.
    return { ...opts.prev, version, providers, source: info.source, checkedAt: info.checkedAt };
  }

  const probe = deps.probeInitialize ?? spawnInitializeProbe;
  const methods = await probe(bin, ['acp'], env, PROBE_TIMEOUT_MS);
  if (methods === null) {
    const fallback = loggedInProviders[0];
    if (fallback) return { ...common, state: 'logged-in', method: 'provider', provider: fallback.id, detail: 'probe-failed' };
    return { ...common, state: 'error', detail: 'probe-failed' };
  }
  const agentMethod = methods.find((m) => m.type === undefined || m.type === 'agent');
  if (agentMethod) return { ...common, state: 'logged-in', method: 'provider', provider: agentMethod.id };
  return { ...common, state: 'logged-out', detail: 'no-credentials' };
}
