import { describe, expect, it } from 'vitest';
import { buildAcpEnv } from '../../src/core/acpEnv';

const BASE: Record<string, string | undefined> = {
  PATH: '/usr/bin',
  HOME: '/Users/x',
  ELECTRON_RUN_AS_NODE: '1',
  NODE_OPTIONS: '--inspect',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_PID: '1',
  CLAUDE_CONFIG_DIR: '/c',
  CLAUDE_EFFORT: 'high',
  HOPECODE_HOME: '/h',
  ANTHROPIC_API_KEY: 'k',
  OPENAI_API_KEY: 'o',
  OPENROUTER_API_KEY: 'r',
  CODEX_HOME: '/codex',
  HERMES_ACCEPT_HOOKS: '1',
  GONE: undefined,
};

describe('buildAcpEnv', () => {
  it('drops app / Claude variables for every agent and never injects keys', () => {
    for (const agent of ['codex', 'hermes'] as const) {
      const env = buildAcpEnv(BASE, { agent });
      for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'CLAUDE_CONFIG_DIR', 'CLAUDE_EFFORT', 'HOPECODE_HOME', 'GONE']) {
        expect(env).not.toHaveProperty(k);
      }
      expect(env.PATH).toBe('/usr/bin');
      expect(env.OPENAI_API_KEY).toBe('o');
    }
  });

  it('codex drops ANTHROPIC_* and keeps its own settings', () => {
    const env = buildAcpEnv(BASE, { agent: 'codex' });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.CODEX_HOME).toBe('/codex');
    expect(env.HERMES_ACCEPT_HOOKS).toBe('1');
  });

  it('hermes keeps provider keys but drops HERMES_ACCEPT_HOOKS', () => {
    const env = buildAcpEnv(BASE, { agent: 'hermes' });
    expect(env.ANTHROPIC_API_KEY).toBe('k');
    expect(env.OPENROUTER_API_KEY).toBe('r');
    expect(env).not.toHaveProperty('HERMES_ACCEPT_HOOKS');
  });

  it('adds the scratch git ceiling and fixture variables', () => {
    const env = buildAcpEnv(BASE, { agent: 'codex', gitCeiling: '/scratch', fixture: { stateDir: '/fake' } });
    expect(env.GIT_CEILING_DIRECTORIES).toBe('/scratch');
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.FAKE_ACP_STATE_DIR).toBe('/fake');
    expect(buildAcpEnv(BASE, { agent: 'codex' })).not.toHaveProperty('GIT_CEILING_DIRECTORIES');
  });

  it('does not mutate the base env', () => {
    const base = { PATH: '/p', CLAUDECODE: '1' };
    buildAcpEnv(base, { agent: 'hermes' });
    expect(base).toEqual({ PATH: '/p', CLAUDECODE: '1' });
  });
});
