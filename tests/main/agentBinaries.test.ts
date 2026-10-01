import { describe, expect, it } from 'vitest';
import { createAgentBinaries } from '../../src/main/agents/agentBinaries';

const fakeReq = (path: string | null) =>
  ({
    resolve: (id: string) => {
      if (path === null) throw new Error('nope');
      expect(id).toBe('@zed-industries/codex-acp-darwin-arm64/package.json');
      return path;
    },
  }) as unknown as NodeRequire;

describe('agentBinaries', () => {
  it('codex-acp: platform package, asar -> asar.unpacked', () => {
    const seen: string[] = [];
    const b = createAgentBinaries({
      arch: 'arm64',
      require: fakeReq('/App/Contents/Resources/app.asar/node_modules/@zed-industries/codex-acp-darwin-arm64/package.json'),
      isExecutable: (p) => {
        seen.push(p);
        return true;
      },
    });
    expect(b.resolveCodexAcp()).toBe(
      '/App/Contents/Resources/app.asar.unpacked/node_modules/@zed-industries/codex-acp-darwin-arm64/bin/codex-acp',
    );
  });
  it('codex-acp: falls back to login-shell PATH, else null', () => {
    const b = createAgentBinaries({
      require: fakeReq(null),
      loginEnv: () => ({ PATH: '/x:/opt/bin' }),
      isExecutable: (p) => p === '/opt/bin/codex-acp',
    });
    expect(b.resolveCodexAcp()).toBe('/opt/bin/codex-acp');
    expect(createAgentBinaries({ require: fakeReq(null), isExecutable: () => false }).resolveCodexAcp()).toBeNull();
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
