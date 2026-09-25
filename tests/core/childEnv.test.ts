import { describe, expect, it } from 'vitest';
import { buildChildEnv, scrubEnv } from '../../src/core/childEnv';

const DIRTY_BASE: Record<string, string | undefined> = {
  HOME: '/Users/khope',
  PATH: '/usr/bin:/bin',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_OAUTH_TOKEN: 'token',
  CLAUDE_PID: '1234',
  CLAUDE_CONFIG_DIR: '/Users/khope/.claude',
  CLAUDE_EFFORT: 'high',
  SOME_UNDEFINED: undefined,
};

describe('scrubEnv', () => {
  it('removes every ANTHROPIC_*, CLAUDECODE, CLAUDE_CODE_*, CLAUDE_PID, CLAUDE_CONFIG_DIR, CLAUDE_EFFORT key', () => {
    const result = scrubEnv(DIRTY_BASE);
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.CLAUDECODE).toBeUndefined();
    expect(result.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result.CLAUDE_PID).toBeUndefined();
    expect(result.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(result.CLAUDE_EFFORT).toBeUndefined();
    expect(Object.keys(result)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('preserves HOME, PATH, SHELL, LANG', () => {
    const result = scrubEnv(DIRTY_BASE);
    expect(result.HOME).toBe('/Users/khope');
    expect(result.PATH).toBe('/usr/bin:/bin');
    expect(result.SHELL).toBe('/bin/zsh');
    expect(result.LANG).toBe('en_US.UTF-8');
  });

  it('drops keys with undefined values', () => {
    const result = scrubEnv(DIRTY_BASE);
    expect('SOME_UNDEFINED' in result).toBe(false);
  });
});

describe('buildChildEnv', () => {
  it('injects only the provided CLAUDE_CONFIG_DIR after scrubbing', () => {
    const result = buildChildEnv(DIRTY_BASE, { configDir: '/Users/khope/.hopecode/accounts/abc' });
    expect(result.CLAUDE_CONFIG_DIR).toBe('/Users/khope/.hopecode/accounts/abc');
    expect(result.HOME).toBe('/Users/khope');
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('does not set CLAUDE_CONFIG_DIR when not injected', () => {
    const result = buildChildEnv(DIRTY_BASE, {});
    expect('CLAUDE_CONFIG_DIR' in result).toBe(false);
  });

  it('injects TERM when provided', () => {
    const result = buildChildEnv(DIRTY_BASE, { term: 'xterm-256color' });
    expect(result.TERM).toBe('xterm-256color');
  });

  it('injects CLAUDE_AGENT_SDK_CLIENT_APP when provided', () => {
    const result = buildChildEnv(DIRTY_BASE, { clientApp: 'hopecode/0.1.0' });
    expect(result.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('hopecode/0.1.0');
  });

  it('injects all three together', () => {
    const result = buildChildEnv(DIRTY_BASE, {
      configDir: '/dir',
      term: 'xterm-256color',
      clientApp: 'hopecode/0.1.0',
    });
    expect(result.CLAUDE_CONFIG_DIR).toBe('/dir');
    expect(result.TERM).toBe('xterm-256color');
    expect(result.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('hopecode/0.1.0');
  });
});
