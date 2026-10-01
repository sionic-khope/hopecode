// Deterministic LocalAuthService for fixture / e2e mode (plan 2.9.3, 2.14): no file, process or Keychain access.
// `HOPECODE_FIXTURE_AGENTS="codex:logged-out,hermes:not-installed"` overrides per-agent state (dev env only).
import type { AgentKind, LocalAuthInfo, LocalAuthState } from '../../shared/types';
import type { LocalAuthService } from '../contracts';
import { createLocalAuthService } from '../agents/localAuth/localAuthService';

const STATES: LocalAuthState[] = ['logged-in', 'logged-out', 'not-installed', 'error'];
const KIND: Record<string, AgentKind> = { claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex', hermes: 'hermes' };
const AT = 1_700_000_000_000;

export function parseFixtureAgents(raw: string | undefined): Partial<Record<AgentKind, LocalAuthState>> {
  const out: Partial<Record<AgentKind, LocalAuthState>> = {};
  for (const part of (raw ?? '').split(',')) {
    const [name, state] = part.trim().split(':');
    const agent = name ? KIND[name] : undefined;
    if (agent && state && (STATES as string[]).includes(state)) out[agent] = state as LocalAuthState;
  }
  return out;
}

export function createFixtureLocalAuth(env: NodeJS.ProcessEnv = process.env): LocalAuthService {
  const overrides = parseFixtureAgents(env['HOPECODE_FIXTURE_AGENTS']);
  const localClaude = env['HOPECODE_FIXTURE_LOCAL_CLAUDE'] === '1';

  function make(agent: AgentKind, defaults: Omit<LocalAuthInfo, 'agent' | 'checkedAt' | 'state'> & { state: LocalAuthState }): LocalAuthInfo {
    const state = overrides[agent] ?? defaults.state;
    const base: LocalAuthInfo = { agent, ...defaults, state, checkedAt: AT };
    if (state === 'logged-in') return base;
    return { ...base, method: null, email: null, plan: null, provider: null, defaultModel: null, defaultProvider: null, detail: state === 'error' ? 'fixture-error' : null };
  }

  const claude = make('claude-code', {
    state: localClaude ? 'logged-in' : 'logged-out',
    method: 'claude.ai',
    email: 'local@fixture.test',
    plan: 'max',
    provider: null,
    source: 'Keychain: Claude Code-credentials',
    version: null,
    detail: null,
  });
  const codex = make('codex', {
    state: 'logged-in',
    method: 'chatgpt',
    email: 'codex@fixture.test',
    plan: 'plus',
    provider: null,
    source: '~/.codex/auth.json',
    version: null,
    detail: null,
  });
  const hermes = make('hermes', {
    state: 'logged-in',
    method: 'provider',
    email: null,
    plan: null,
    provider: 'fixture-provider',
    source: '~/.local/bin/hermes',
    version: '0.0.0-fixture',
    detail: null,
    defaultModel: 'deepseek/deepseek-v4.1-flash-ultrafast',
    defaultProvider: 'og',
  });

  return createLocalAuthService({
    detectors: {
      'claude-code': async () => claude,
      codex: async () => codex,
      hermes: async () => hermes,
    },
    now: () => AT,
  });
}
