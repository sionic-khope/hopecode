import type { ChildEnvInject } from '../shared/types';

const SCRUB_PREFIXES = [/^ANTHROPIC_/, /^CLAUDE_CODE_/];
const SCRUB_EXACT = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CONFIG_DIR', 'CLAUDE_EFFORT']);

/**
 * Removes: /^ANTHROPIC_/, CLAUDECODE, /^CLAUDE_CODE_/, CLAUDE_PID, CLAUDE_CONFIG_DIR, CLAUDE_EFFORT, undefined values.
 */
export function scrubEnv(base: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SCRUB_EXACT.has(key)) continue;
    if (SCRUB_PREFIXES.some((re) => re.test(key))) continue;
    result[key] = value;
  }
  return result;
}

/** scrubEnv(base) then inject CLAUDE_CONFIG_DIR / TERM / CLAUDE_AGENT_SDK_CLIENT_APP when provided. */
export function buildChildEnv(
  base: Record<string, string | undefined>,
  inject: ChildEnvInject,
): Record<string, string> {
  const result = scrubEnv(base);
  if (inject.configDir !== undefined) result.CLAUDE_CONFIG_DIR = inject.configDir;
  if (inject.term !== undefined) result.TERM = inject.term;
  if (inject.clientApp !== undefined) result.CLAUDE_AGENT_SDK_CLIENT_APP = inject.clientApp;
  return result;
}
