// Real AcpLaunchers (plan 2.2 / 2.10 / 2.11 / 2.15): Codex = the bundled codex-acp adapter driving the installed Codex
// engine (`CODEX_PATH`), configured through env (`CODEX_CONFIG`, `INITIAL_AGENT_MODE`); Hermes = the detected
// `hermes acp`. argv arrays only (no shell); the env starts from the login shell and never carries an injected key or
// token. The env is rebuilt on every resolve (each spawn / respawn).
import type { AcpAgentKind } from '../../core/acpTypes';
import { buildAcpEnv } from '../../core/acpEnv';
import { codexLaunchEnv } from '../../core/agentDefaults';
import type { EffortLevel } from '../../shared/types';
import type { AcpLauncher } from '../contracts';
import type { AgentBinaries } from './agentBinaries';

export interface AcpLaunchersDeps {
  binaries: Pick<AgentBinaries, 'resolveCodexAcp' | 'codexEngine' | 'resolveHermes'>;
  /** ShellEnv.baseEnv (login shell). */
  baseEnv: () => Record<string, string>;
}

export function createAcpLaunchers(deps: AcpLaunchersDeps): Record<AcpAgentKind, AcpLauncher> {
  return {
    codex: {
      resolve(_cwd, opts) {
        const command = deps.binaries.resolveCodexAcp();
        // The engine comes from the (async) local-auth detection; no engine yet = not installed.
        const engine = deps.binaries.codexEngine();
        if (!command || !engine) return { ok: false, reason: 'not-installed' };
        const wanted = codexLaunchEnv({ model: opts.model ?? null, effort: (opts.effort ?? null) as EffortLevel | null, permissionMode: opts.permissionMode });
        // A stored model / effort that fails validation is never passed on: Codex then runs with its own default.
        const launch = wanted.ok ? wanted : codexLaunchEnv({ model: null, effort: null, permissionMode: opts.permissionMode });
        if (!launch.ok) return { ok: false, reason: 'not-installed' };
        const env = {
          ...buildAcpEnv(deps.baseEnv(), { agent: 'codex', ...(opts.gitCeiling !== undefined ? { gitCeiling: opts.gitCeiling } : {}) }),
          // Always set (never inherited from the login shell): the shell cannot pick the adapter's `agent` default.
          CODEX_PATH: engine.path,
          ...launch.env,
        };
        return { ok: true, spec: { command, args: [], env } };
      },
    },
    hermes: {
      resolve(_cwd, opts) {
        const command = deps.binaries.resolveHermes();
        if (!command) return { ok: false, reason: 'not-installed' };
        const env = buildAcpEnv(deps.baseEnv(), { agent: 'hermes', ...(opts.gitCeiling !== undefined ? { gitCeiling: opts.gitCeiling } : {}) });
        return { ok: true, spec: { command, args: ['acp'], env } };
      },
    },
  };
}
