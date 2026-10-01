// Child env for ACP agents (plan 2.10). Pure; the result is never logged.
import type { BuildAcpEnvFn } from './acpTypes';

const COMMON_DROP_EXACT = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_EFFORT',
]);
const COMMON_DROP_PREFIX = [/^CLAUDE_CODE_/, /^HOPECODE_/];

export const buildAcpEnv: BuildAcpEnvFn = (base, opts) => {
  const dropAnthropic = opts.agent === 'codex';
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (COMMON_DROP_EXACT.has(key) || COMMON_DROP_PREFIX.some((re) => re.test(key))) continue;
    if (dropAnthropic && /^ANTHROPIC_/.test(key)) continue;
    if (opts.agent === 'hermes' && key === 'HERMES_ACCEPT_HOOKS') continue;
    env[key] = value;
  }
  if (opts.gitCeiling !== undefined) env.GIT_CEILING_DIRECTORIES = opts.gitCeiling;
  if (opts.fixture) {
    env.ELECTRON_RUN_AS_NODE = '1';
    env.FAKE_ACP_STATE_DIR = opts.fixture.stateDir;
  }
  return env;
};
