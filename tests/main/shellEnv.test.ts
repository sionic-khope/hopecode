import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildEnvInject } from '../../src/shared/types';

// Mock core/childEnv so this test verifies only what it is responsible for:
// that shellEnv.childEnv() delegates to core/childEnv.buildChildEnv.
// (vitest hoists vi.mock() above the static import below, so load order is safe.)
const buildChildEnvMock = vi.fn((base: Record<string, string>, inject: ChildEnvInject) => ({
  ...base,
  ...inject,
  __mocked: true,
}));

vi.mock('../../src/core/childEnv', () => ({
  scrubEnv: vi.fn((base: Record<string, string>) => base),
  buildChildEnv: buildChildEnvMock,
}));

const { createShellEnv } = await import('../../src/main/shellEnv');

describe('shellEnv', () => {
  beforeEach(() => {
    buildChildEnvMock.mockClear();
  });

  it('childEnv() delegates to core/childEnv.buildChildEnv with baseEnv + the given inject', () => {
    const shellEnv = createShellEnv({ HOME: '/home/x', PATH: '/usr/bin' });
    const inject: ChildEnvInject = { configDir: '/cfg' };

    const result = shellEnv.childEnv(inject);

    expect(buildChildEnvMock).toHaveBeenCalledTimes(1);
    const [baseArg, injectArg] = buildChildEnvMock.mock.calls[0]!;
    expect(injectArg).toBe(inject);
    expect(baseArg).toMatchObject({ HOME: '/home/x' });
    expect(result).toMatchObject({ configDir: '/cfg', __mocked: true });
  });

  it('baseEnv() falls back to process env plus the fallback PATH entries before init()', () => {
    const shellEnv = createShellEnv({ HOME: '/home/x', PATH: '/usr/bin' });
    const base = shellEnv.baseEnv();
    expect(base['PATH']).toContain('/usr/bin');
    expect(base['PATH']).toContain('/usr/local/bin');
    expect(base['PATH']).toContain('/opt/homebrew/bin');
  });

  it('init() captures env from the login shell (env -0 parsing)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hopecode-shell-'));
    const script = join(dir, 'fakeshell.sh');
    try {
      await writeFile(script, '#!/bin/sh\nprintf "PATH=/custom/bin\\0HOME=/home/test\\0FOO=bar\\0"\n');
      await chmod(script, 0o755);

      const shellEnv = createShellEnv({ SHELL: script, HOME: '/home/real', PATH: '/usr/bin' });
      await shellEnv.init();

      expect(shellEnv.baseEnv()).toEqual({ PATH: '/custom/bin', HOME: '/home/test', FOO: 'bar' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('init() falls back to process env when the login shell fails', async () => {
    const shellEnv = createShellEnv({ SHELL: '/nonexistent/shell', HOME: '/home/real', PATH: '/usr/bin' });
    await shellEnv.init();
    const base = shellEnv.baseEnv();
    expect(base['HOME']).toBe('/home/real');
    expect(base['PATH']).toContain('/usr/bin');
    expect(base['PATH']).toContain('/usr/local/bin');
  });
});
