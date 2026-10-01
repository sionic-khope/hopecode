import { describe, expect, it } from 'vitest';
import {
  checkCodexEngine,
  CODEX_MIN_VERSION,
  compareVersions,
  createAgentBinaries,
  parseCodexVersion,
} from '../../src/main/agents/agentBinaries';

const APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const USER_APP_CODEX = '/fake/home/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

/** Fake `codex --version` table; unknown paths fail like a broken binary. */
const versions = (table: Record<string, string>) => {
  const calls: string[] = [];
  const probe = async (path: string) => {
    calls.push(path);
    return table[path] ?? null;
  };
  return { probe, calls };
};

describe('codex version helpers', () => {
  it('parses `codex-cli X.Y.Z` (and tolerates suffixes), rejects garbage', () => {
    expect(parseCodexVersion('codex-cli 0.159.2\n')).toBe('0.159.2');
    expect(parseCodexVersion('codex-cli 0.160.0-alpha.3')).toBe('0.160.0');
    expect(parseCodexVersion('WARN something\ncodex-cli 1.2.3')).toBe('1.2.3');
    expect(parseCodexVersion('')).toBeNull();
    expect(parseCodexVersion('codex-cli dev')).toBeNull();
  });
  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.159.2', '0.150.0')).toBeGreaterThan(0);
    expect(compareVersions('0.99.0', '0.150.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0);
    expect(compareVersions('0.150.0', CODEX_MIN_VERSION)).toBe(0);
  });
  it('checkCodexEngine: absolute + executable + parsable + >= minimum', async () => {
    const v = versions({ '/ok/codex': 'codex-cli 0.159.2', '/old/codex': 'codex-cli 0.149.9', '/junk/codex': 'hello' });
    const deps = { isExecutable: (p: string) => p !== '/nox/codex', codexVersion: v.probe };
    expect(await checkCodexEngine('/ok/codex', deps)).toEqual({ ok: true, engine: { path: '/ok/codex', version: '0.159.2' } });
    expect((await checkCodexEngine('/old/codex', deps)).ok).toBe(false);
    expect((await checkCodexEngine('/junk/codex', deps)).ok).toBe(false);
    expect((await checkCodexEngine('/nox/codex', deps)).ok).toBe(false);
    expect((await checkCodexEngine('relative/codex', deps)).ok).toBe(false);
    expect(v.calls).not.toContain('/nox/codex');
  });
});

describe('agentBinaries', () => {
  it('codex-acp: packaged Resources/bin first, then <appRoot>/build/bin, else null (no PATH fallback)', () => {
    const exec = new Set(['/App/Contents/Resources/bin/codex-acp', '/repo/build/bin/codex-acp', '/opt/bin/codex-acp']);
    const isExecutable = (p: string) => exec.has(p);
    const loginEnv = () => ({ PATH: '/opt/bin' });
    expect(createAgentBinaries({ resourcesPath: '/App/Contents/Resources', isExecutable, loginEnv }).resolveCodexAcp()).toBe(
      '/App/Contents/Resources/bin/codex-acp',
    );
    expect(createAgentBinaries({ appRoot: '/repo', isExecutable, loginEnv }).resolveCodexAcp()).toBe('/repo/build/bin/codex-acp');
    expect(createAgentBinaries({ appRoot: '/elsewhere', isExecutable, loginEnv }).resolveCodexAcp()).toBeNull();
  });

  it('codex engine: highest version wins across ChatGPT.app, ~/Applications, login PATH and common dirs', async () => {
    const exec = new Set([APP_CODEX, USER_APP_CODEX, '/login/bin/codex', '/opt/homebrew/bin/codex', '/fake/home/.local/bin/codex']);
    const v = versions({
      [APP_CODEX]: 'codex-cli 0.159.2',
      [USER_APP_CODEX]: 'codex-cli 0.158.0',
      '/login/bin/codex': 'codex-cli 0.161.0',
      '/opt/homebrew/bin/codex': 'codex-cli 0.120.0',
      '/fake/home/.local/bin/codex': 'garbage',
    });
    const b = createAgentBinaries({
      homedir: () => '/fake/home',
      loginEnv: () => ({ PATH: '/login/bin' }),
      isExecutable: (p) => exec.has(p),
      codexVersion: v.probe,
    });
    expect(b.codexEngine()).toBeNull();
    expect(await b.resolveCodex()).toEqual({ path: '/login/bin/codex', version: '0.161.0' });
    expect(b.codexEngine()).toEqual({ path: '/login/bin/codex', version: '0.161.0' });
    expect(v.calls).toEqual([APP_CODEX, USER_APP_CODEX, '/login/bin/codex', '/opt/homebrew/bin/codex', '/fake/home/.local/bin/codex']);
    // Cached until invalidate.
    await b.resolveCodex();
    expect(v.calls).toHaveLength(5);
  });

  it('codex engine: ChatGPT.app wins a version tie; below the minimum is excluded; none -> null', async () => {
    const exec = new Set([APP_CODEX, '/usr/local/bin/codex']);
    const tie = versions({ [APP_CODEX]: 'codex-cli 0.159.2', '/usr/local/bin/codex': 'codex-cli 0.159.2' });
    expect(await createAgentBinaries({ homedir: () => '/h', isExecutable: (p) => exec.has(p), codexVersion: tie.probe }).resolveCodex()).toEqual({
      path: APP_CODEX,
      version: '0.159.2',
    });
    const old = versions({ [APP_CODEX]: 'codex-cli 0.140.0', '/usr/local/bin/codex': 'codex-cli 0.149.99' });
    expect(await createAgentBinaries({ homedir: () => '/h', isExecutable: (p) => exec.has(p), codexVersion: old.probe }).resolveCodex()).toBeNull();
    const none = versions({});
    const b = createAgentBinaries({ homedir: () => '/h', loginEnv: () => ({ PATH: '/x' }), isExecutable: () => false, codexVersion: none.probe });
    expect(await b.resolveCodex()).toBeNull();
    expect(none.calls).toEqual([]);
  });

  it('codex engine: the settings override is a candidate (first) and is re-read after invalidate', async () => {
    let override = '/custom/codex';
    const exec = new Set([APP_CODEX, '/custom/codex', '/custom2/codex']);
    const v = versions({ [APP_CODEX]: 'codex-cli 0.159.2', '/custom/codex': 'codex-cli 0.170.0', '/custom2/codex': 'codex-cli 0.150.0' });
    const b = createAgentBinaries({ homedir: () => '/h', isExecutable: (p) => exec.has(p), codexVersion: v.probe, codexOverride: () => override });
    expect(await b.resolveCodex()).toEqual({ path: '/custom/codex', version: '0.170.0' });
    expect(v.calls[0]).toBe('/custom/codex');
    override = '/custom2/codex';
    b.invalidate();
    // An older override does not beat a newer ChatGPT.app engine.
    expect(await b.resolveCodex()).toEqual({ path: APP_CODEX, version: '0.159.2' });
  });

  it('hermes: PATH, then ~/.local/bin, then login env; cached until invalidate', () => {
    const exec = new Set(['/fake/home/.local/bin/hermes']);
    const b = createAgentBinaries({
      pathEnv: '/usr/bin',
      homedir: () => '/fake/home',
      loginEnv: () => ({ PATH: '/login/bin' }),
      isExecutable: (p) => exec.has(p),
    });
    expect(b.resolveHermes()).toBe('/fake/home/.local/bin/hermes');
    exec.clear();
    exec.add('/usr/bin/hermes');
    expect(b.resolveHermes()).toBe('/fake/home/.local/bin/hermes');
    b.invalidate();
    expect(b.resolveHermes()).toBe('/usr/bin/hermes');
    exec.clear();
    exec.add('/login/bin/hermes');
    b.invalidate();
    expect(b.resolveHermes()).toBe('/login/bin/hermes');
    exec.clear();
    b.invalidate();
    expect(b.resolveHermes()).toBeNull();
  });
});
