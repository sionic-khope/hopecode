// Claude local login: `claude auth status --json` with no CLAUDE_CONFIG_DIR (plan 2.9.2 / 0.4). The Keychain item
// `Claude Code-credentials` is read by the CLI itself; nothing here reads or writes credentials.
import type { ChildEnvInject, LocalAuthInfo } from '../../../shared/types';
import { parseAuthStatus } from '../../accounts/loginFlow';
import { baseInfo, type DetectorDeps } from './detectorDeps';

const AUTH_STATUS_TIMEOUT_MS = 10_000;

export interface ClaudeDetectorDeps extends DetectorDeps {
  /** `claudeBinary.resolvePath` (throws when not found). */
  claudePath: () => string;
  /** ShellEnv.childEnv; called with `{}` so CLAUDE_CONFIG_DIR is never injected. */
  childEnv: (inject: ChildEnvInject) => Record<string, string>;
}

export async function detectClaude(deps: ClaudeDetectorDeps): Promise<LocalAuthInfo> {
  const info = baseInfo('claude-code', 'Keychain: Claude Code-credentials', deps.now());
  let bin: string;
  try {
    bin = deps.claudePath();
  } catch {
    return { ...info, state: 'not-installed', detail: 'claude-not-found' };
  }
  const res = await deps.runCommand(bin, ['auth', 'status', '--json'], {
    env: deps.childEnv({}),
    timeout: AUTH_STATUS_TIMEOUT_MS,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch {
    return { ...info, state: 'error', detail: res.code === 0 ? 'status-unreadable' : `exit-${res.code}` };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...info, state: 'error', detail: 'status-unreadable' };
  if ((parsed as Record<string, unknown>)['loggedIn'] !== true) return { ...info, state: 'logged-out' };
  const r = parseAuthStatus(res.stdout);
  if (!r.ok) return { ...info, state: 'error', detail: 'unsupported-auth-method' };
  return { ...info, state: 'logged-in', method: 'claude.ai', email: r.email, plan: r.plan };
}
