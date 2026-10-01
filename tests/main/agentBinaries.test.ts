import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkCodexEngine,
  CODEX_MIN_VERSION,
  compareVersions,
  createAgentBinaries,
  createCodexVersionProbe,
  inspectEngineFile,
  parseCodexVersion,
} from '../../src/main/agents/agentBinaries';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const tmp = () => (dir ??= realpathSync(mkdtempSync(join(tmpdir(), 'hopecode-agentbin-'))));

const APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const USER_APP_CODEX = '/fake/home/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

/** Engine file check stand-in: executable set members pass as-is (no realpath change). */
const inspectIn = (exec: Set<string>) => (p: string) => (exec.has(p) ? { ok: true as const, path: p } : { ok: false as const, error: 'nope' });

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
  it('checkCodexEngine: file checks first, then parsable + >= minimum; the engine path is the realpath', async () => {
    const v = versions({ '/real/ok': 'codex-cli 0.159.2', '/old/codex': 'codex-cli 0.149.9', '/junk/codex': 'hello' });
    const inspectEngine = (p: string) =>
      p === '/nox/codex' ? { ok: false as const, error: 'nope' } : { ok: true as const, path: p === '/ok/codex' ? '/real/ok' : p };
    const deps = { inspectEngine, codexVersion: v.probe };
    expect(await checkCodexEngine('/ok/codex', deps)).toEqual({ ok: true, engine: { path: '/real/ok', version: '0.159.2' } });
    expect((await checkCodexEngine('/old/codex', deps)).ok).toBe(false);
    expect((await checkCodexEngine('/junk/codex', deps)).ok).toBe(false);
    expect(await checkCodexEngine('/nox/codex', deps)).toEqual({ ok: false, error: 'nope' });
    expect(v.calls).toEqual(['/real/ok', '/old/codex', '/junk/codex']);
  });
});

describe('inspectEngineFile', () => {
  const file = (name: string, mode: number) => {
    const p = join(tmp(), name);
    writeFileSync(p, '#!/bin/sh\n');
    chmodSync(p, mode);
    return p;
  };

  it('a regular executable owned by me, not group/world-writable -> its realpath (symlinks resolved)', () => {
    const real = file('codex', 0o755);
    const link = join(tmp(), 'link');
    symlinkSync(real, link);
    expect(inspectEngineFile(real)).toEqual({ ok: true, path: real });
    expect(inspectEngineFile(link)).toEqual({ ok: true, path: real });
  });

  it('rejects relative, missing, directories, non-executable, group/world-writable and foreign-owned files', () => {
    expect(inspectEngineFile('relative/codex').ok).toBe(false);
    expect(inspectEngineFile(join(tmp(), 'missing')).ok).toBe(false);
    const d = join(tmp(), 'dir');
    mkdirSync(d);
    expect(inspectEngineFile(d)).toEqual({ ok: false, error: '일반 파일이 아닙니다' });
    expect(inspectEngineFile(file('noexec', 0o644)).ok).toBe(false);
    expect(inspectEngineFile(file('world', 0o757)).ok).toBe(false);
    expect(inspectEngineFile(file('group', 0o775)).ok).toBe(false);
    // A symlink to a writable target is judged by the target.
    const link = join(tmp(), 'to-world');
    symlinkSync(file('world2', 0o777), link);
    expect(inspectEngineFile(link).ok).toBe(false);
    const mine = file('mine', 0o755);
    expect(inspectEngineFile(mine, { uid: () => 424242 }).ok).toBe(false);
    // root-owned is accepted.
    expect(inspectEngineFile(mine, { uid: () => 424242, stat: () => ({ isFile: () => true, mode: 0o100755, uid: 0 }) }).ok).toBe(true);
  });
});

describe('codex --version probe', () => {
  it('runs with the login PATH (an env-node shebang finds its interpreter) and a minimal env', async () => {
    const bin = join(tmp(), 'bin');
    mkdirSync(bin);
    // `#!/usr/bin/env fakenode` like an npm-installed codex: fakenode lives only on the login PATH.
    writeFileSync(join(bin, 'fakenode'), '#!/bin/sh\necho "codex-cli 0.170.0"\nenv\n');
    chmodSync(join(bin, 'fakenode'), 0o755);
    const codex = join(tmp(), 'codex');
    writeFileSync(codex, '#!/usr/bin/env fakenode\n');
    chmodSync(codex, 0o755);
    process.env['HOPECODE_PROBE_LEAK'] = 'leak';
    try {
      const out = await createCodexVersionProbe(() => `${bin}:/usr/bin:/bin`)(codex);
      expect(out && parseCodexVersion(out.split('\n')[0]!)).toBe('0.170.0');
      expect(out).not.toContain('HOPECODE_PROBE_LEAK');
      expect(out).toMatch(/^HOME=.*hopecode-codex-ver-/m);
      expect(await createCodexVersionProbe()(codex)).toBeNull();
    } finally {
      delete process.env['HOPECODE_PROBE_LEAK'];
    }
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
      inspectEngine: inspectIn(exec),
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
    expect(await createAgentBinaries({ homedir: () => '/h', isExecutable: (p) => exec.has(p), inspectEngine: inspectIn(exec), codexVersion: tie.probe }).resolveCodex()).toEqual({
      path: APP_CODEX,
      version: '0.159.2',
    });
    const old = versions({ [APP_CODEX]: 'codex-cli 0.140.0', '/usr/local/bin/codex': 'codex-cli 0.149.99' });
    expect(await createAgentBinaries({ homedir: () => '/h', isExecutable: (p) => exec.has(p), inspectEngine: inspectIn(exec), codexVersion: old.probe }).resolveCodex()).toBeNull();
    const none = versions({});
    const b = createAgentBinaries({ homedir: () => '/h', loginEnv: () => ({ PATH: '/x' }), isExecutable: () => false, inspectEngine: inspectIn(new Set()), codexVersion: none.probe });
    expect(await b.resolveCodex()).toBeNull();
    expect(none.calls).toEqual([]);
  });

  it('codex engine: a settings override is the only candidate; a failing override is null + error, never a fallback', async () => {
    let override = '/custom/codex';
    const exec = new Set([APP_CODEX, '/custom/codex', '/custom2/codex']);
    const v = versions({ [APP_CODEX]: 'codex-cli 0.159.2', '/custom/codex': 'codex-cli 0.170.0', '/custom2/codex': 'codex-cli 0.150.0', '/old/codex': 'codex-cli 0.1.0' });
    const b = createAgentBinaries({ homedir: () => '/h', isExecutable: (p) => exec.has(p), inspectEngine: inspectIn(exec), codexVersion: v.probe, codexOverride: () => override });
    expect(await b.resolveCodex()).toEqual({ path: '/custom/codex', version: '0.170.0' });
    expect(v.calls).toEqual(['/custom/codex']);
    expect(b.codexEngineError()).toBeNull();
    // An older (still supported) override is used even though ChatGPT.app is newer.
    override = '/custom2/codex';
    b.invalidate();
    expect(await b.resolveCodex()).toEqual({ path: '/custom2/codex', version: '0.150.0' });
    // A broken override: no engine (not-installed), with the reason; ChatGPT.app is never tried.
    override = '/missing/codex';
    b.invalidate();
    expect(await b.resolveCodex()).toBeNull();
    expect(b.codexEngineError()).toBe('nope');
    exec.add('/old/codex');
    override = '/old/codex';
    b.invalidate();
    expect(await b.resolveCodex()).toBeNull();
    expect(b.codexEngineError()).toContain('지원하지 않습니다');
    expect(v.calls).not.toContain(APP_CODEX);
    // Cleared override -> auto-detection again.
    override = '';
    b.invalidate();
    expect(await b.resolveCodex()).toEqual({ path: APP_CODEX, version: '0.159.2' });
    expect(b.codexEngineError()).toBeNull();
  });

  it('invalidate drops the cached engine at once; callers then await the new detection', async () => {
    const exec = new Set([APP_CODEX]);
    let answer = 'codex-cli 0.159.2';
    const b = createAgentBinaries({ homedir: () => '/h', isExecutable: (p) => exec.has(p), inspectEngine: inspectIn(exec), codexVersion: async () => answer });
    await b.resolveCodex();
    expect(b.codexEngine()).toEqual({ path: APP_CODEX, version: '0.159.2' });
    answer = 'codex-cli 0.161.0';
    b.invalidate();
    expect(b.codexEngine()).toBeNull();
    expect(await b.resolveCodex()).toEqual({ path: APP_CODEX, version: '0.161.0' });
    expect(b.codexEngine()).toEqual({ path: APP_CODEX, version: '0.161.0' });
  });

  it('verifyCodexEngine / checkCodexPath use the same engine file check', async () => {
    const exec = new Set(['/ok/codex']);
    const b = createAgentBinaries({ inspectEngine: inspectIn(exec), codexVersion: async () => 'codex-cli 0.160.0' });
    expect(b.verifyCodexEngine('/ok/codex')).toBe('/ok/codex');
    expect(b.verifyCodexEngine('/bad/codex')).toBeNull();
    expect(await b.checkCodexPath('/ok/codex')).toEqual({ ok: true, engine: { path: '/ok/codex', version: '0.160.0' } });
    expect(await b.checkCodexPath('/bad/codex')).toEqual({ ok: false, error: 'nope' });
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
