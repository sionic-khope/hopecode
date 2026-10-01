// Fixture-mode (`HOPECODE_FIXTURES=1`, vitest, e2e) AcpLauncher: starts tests/fixtures/acp/fakeAcpAgent.mjs with
// `process.execPath` + ELECTRON_RUN_AS_NODE=1 (plan 4). Never spawns a real codex-acp / hermes, no network.
// Paths are injected so this module stays free of electron imports (the caller passes
// `join(app.getAppPath(), 'tests/fixtures/acp/fakeAcpAgent.mjs')` and `join(hopecodeHome(), 'fake-acp')`).
import { codexLaunchEnv } from '../../core/agentDefaults';
import type { EffortLevel } from '../../shared/types';
import type { AcpLauncher, AcpLaunchOptions } from '../contracts';

export type FakeAcpProfile = 'codex' | 'hermes' | 'noload';

/** CODEX_PATH the fixture agent reports back (it never runs a real codex). */
export const FIXTURE_CODEX_PATH = '/fixture/codex';

export interface AcpFixtureLauncherOptions {
  profile: FakeAcpProfile;
  /** Absolute path of fakeAcpAgent.mjs. */
  scriptPath: string;
  /** FAKE_ACP_STATE_DIR (session persistence for load replay). */
  stateDir: string;
  /** Defaults to process.execPath. */
  command?: string;
  /** Extra env for the agent (e.g. FAKE_ACP_NO_MODELS=1, FAKE_ACP_AUTH_REQUIRED=1). */
  env?: Record<string, string>;
  /** Simulate a missing install / login. */
  unavailable?: 'not-installed' | 'not-logged-in';
}

/** Same env as the real launcher (agentDefaults `codexLaunchEnv`); an invalid model / effort falls back to defaults. */
function codexEnv(opts: AcpLaunchOptions): Record<string, string> {
  const noTools = opts.noTools ? { noTools: opts.noTools } : {};
  const input = { model: opts.model ?? null, effort: (opts.effort ?? null) as EffortLevel | null, permissionMode: opts.permissionMode, ...noTools };
  const res = codexLaunchEnv(input);
  const launch = res.ok ? res : codexLaunchEnv({ model: null, effort: null, permissionMode: opts.permissionMode, ...noTools });
  return launch.ok ? { CODEX_PATH: FIXTURE_CODEX_PATH, ...launch.env } : {};
}

export function createAcpFixtureLauncher(o: AcpFixtureLauncherOptions): AcpLauncher {
  return {
    resolve(_cwd, opts) {
      if (o.unavailable) return { ok: false, reason: o.unavailable };
      const env: Record<string, string> = {
        ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>),
        ELECTRON_RUN_AS_NODE: '1',
        FAKE_ACP_PROFILE: o.profile,
        FAKE_ACP_STATE_DIR: o.stateDir,
        ...(opts.gitCeiling ? { GIT_CEILING_DIRECTORIES: opts.gitCeiling } : {}),
        ...(o.profile === 'hermes' ? {} : codexEnv(opts)),
        ...o.env,
      };
      return {
        ok: true,
        spec: { command: o.command ?? process.execPath, args: [o.scriptPath], env },
      };
    },
  };
}
