// Fixture-mode (`HOPECODE_FIXTURES=1`, vitest, e2e) AcpLauncher: starts tests/fixtures/acp/fakeAcpAgent.mjs with
// `process.execPath` + ELECTRON_RUN_AS_NODE=1 (plan 4). Never spawns a real codex-acp / hermes, no network.
// Paths are injected so this module stays free of electron imports (the caller passes
// `join(app.getAppPath(), 'tests/fixtures/acp/fakeAcpAgent.mjs')` and `join(hopecodeHome(), 'fake-acp')`).
import type { UiPermissionMode } from '../../shared/types';
import type { AcpLauncher, AcpLaunchOptions } from '../contracts';

export type FakeAcpProfile = 'codex' | 'hermes' | 'noload';

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

// plan 2.15: UI permission mode -> codex `-c approval_policy / sandbox_mode`.
const CODEX_PERMISSION: Record<UiPermissionMode, { approval_policy: string; sandbox_mode: string }> = {
  default: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' },
  acceptEdits: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' },
  plan: { approval_policy: 'on-request', sandbox_mode: 'read-only' },
  bypassPermissions: { approval_policy: 'never', sandbox_mode: 'danger-full-access' },
};

function codexArgs(opts: AcpLaunchOptions): string[] {
  const kv: string[] = [];
  if (opts.model) kv.push(`model="${opts.model}"`);
  if (opts.effort) kv.push(`model_reasoning_effort="${opts.effort}"`);
  const p = CODEX_PERMISSION[opts.permissionMode];
  if (p) kv.push(`approval_policy="${p.approval_policy}"`, `sandbox_mode="${p.sandbox_mode}"`);
  return kv.flatMap((v) => ['-c', v]);
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
        ...o.env,
      };
      return {
        ok: true,
        spec: { command: o.command ?? process.execPath, args: [o.scriptPath, ...(o.profile === 'hermes' ? [] : codexArgs(opts))], env },
      };
    },
  };
}
