import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCredentials, SECURITY_BIN, type ExecFileFn } from '../../src/main/accounts/credentials';

const NOW = 1_800_000_000_000;
const DIR = '/Users/test/.hopecode/accounts/acc-1';
const SERVICE = 'Claude Code-credentials-test';

const creds = (expiresAt: number | null, token = 'tok') =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: 'refresh',
      expiresAt,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
  });

function setup(opts: {
  keychain?: Record<string, string>; // key: 'user' | 'nouser'
  file?: string;
  now?: () => number;
  serviceName?: (d: string) => string;
}) {
  const execFile = vi.fn<ExecFileFn>(async (_file, args) => {
    const key = args.includes('-a') ? 'user' : 'nouser';
    const out = opts.keychain?.[key];
    if (args[0] === 'find-generic-password' && out !== undefined) return { stdout: out + '\n' };
    throw new Error('security: item not found');
  });
  const readFile = vi.fn(async (p: string) => {
    if (opts.file !== undefined && p === `${DIR}/.credentials.json`) return opts.file;
    throw new Error('ENOENT');
  });
  const c = createCredentials({
    execFile,
    readFile,
    username: () => 'alice',
    now: opts.now ?? (() => NOW),
    platform: 'darwin',
    serviceName: opts.serviceName ?? (() => SERVICE),
  });
  return { c, execFile, readFile };
}

describe('credentials (read-only)', () => {
  it('uses the Claude Code keychain service name for the config dir (sha256 of the verbatim string)', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => {
      throw new Error('nope');
    });
    const c = createCredentials({ execFile, readFile: async () => '', username: () => 'alice', platform: 'darwin' });
    await c.read(DIR);
    const expected = `Claude Code-credentials-${createHash('sha256').update(DIR).digest('hex').slice(0, 8)}`;
    expect(execFile.mock.calls[0]![1]).toContain(expected);
  });

  it('queries `-a <user>` first, then without account, via /usr/bin/security', async () => {
    const { c, execFile } = setup({ keychain: { nouser: creds(NOW + 60_000) } });
    const r = await c.read(DIR);
    expect(r).toEqual({
      status: 'ok',
      accessToken: 'tok',
      expiresAt: NOW + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });
    expect(execFile.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [SECURITY_BIN, ['find-generic-password', '-s', SERVICE, '-a', 'alice', '-w']],
      [SECURITY_BIN, ['find-generic-password', '-s', SERVICE, '-w']],
    ]);
    expect(execFile.mock.calls[0]![2]).toEqual({ timeout: 2000 });
  });

  it('stops after a valid `-a` hit', async () => {
    const { c, execFile, readFile } = setup({ keychain: { user: creds(NOW + 60_000, 'userTok') } });
    const r = await c.read(DIR);
    expect(r.status === 'ok' && r.accessToken).toBe('userTok');
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('accepts a root-level (non-wrapped) credential object', async () => {
    const { c } = setup({ keychain: { user: JSON.stringify({ accessToken: 'flat', expiresAt: NOW + 1 }) } });
    const r = await c.read(DIR);
    expect(r).toMatchObject({ status: 'ok', accessToken: 'flat', subscriptionType: null });
  });

  it('falls back to <configDir>/.credentials.json', async () => {
    const { c, readFile } = setup({ file: creds(NOW + 60_000, 'fileTok') });
    const r = await c.read(DIR);
    expect(r.status === 'ok' && r.accessToken).toBe('fileTok');
    expect(readFile).toHaveBeenCalledWith(`${DIR}/.credentials.json`);
  });

  it('expired token -> token_expired, never refreshes or writes back', async () => {
    const { c, execFile } = setup({ keychain: { user: creds(NOW - 1) } });
    expect(await c.read(DIR)).toEqual({ status: 'token_expired', expiresAt: NOW - 1 });
    // only find-generic-password reads; no add/update/delete of keychain items
    for (const call of execFile.mock.calls) expect(call[1][0]).toBe('find-generic-password');
  });

  it('prefers a valid file token over an expired keychain token', async () => {
    const { c } = setup({ keychain: { user: creds(NOW - 1) }, file: creds(NOW + 1000, 'fresh') });
    const r = await c.read(DIR);
    expect(r.status === 'ok' && r.accessToken).toBe('fresh');
  });

  it('nothing found -> no_credentials; malformed JSON ignored', async () => {
    expect(await setup({}).c.read(DIR)).toEqual({ status: 'no_credentials' });
    expect(await setup({ keychain: { user: 'not json' }, file: '{}' }).c.read(DIR)).toEqual({
      status: 'no_credentials',
    });
  });

  it('caches ok results until expiresAt; invalidate forces a re-read', async () => {
    let t = NOW;
    const { c, execFile } = setup({ keychain: { user: creds(NOW + 10_000) }, now: () => t });
    await c.read(DIR);
    await c.read(DIR);
    expect(execFile).toHaveBeenCalledTimes(1);
    c.invalidate(DIR);
    await c.read(DIR);
    expect(execFile).toHaveBeenCalledTimes(2);
    t = NOW + 10_000;
    expect((await c.read(DIR)).status).toBe('token_expired');
  });

  it('does not touch the keychain off darwin', async () => {
    const execFile = vi.fn<ExecFileFn>();
    const c = createCredentials({ execFile, readFile: async () => creds(NOW + 1), platform: 'linux', now: () => NOW });
    expect((await c.read(DIR)).status).toBe('ok');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('deleteKeychainItem calls delete-generic-password for the service and swallows missing items', async () => {
    const { c, execFile } = setup({});
    await expect(c.deleteKeychainItem(DIR)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledWith(SECURITY_BIN, ['delete-generic-password', '-s', SERVICE], {
      timeout: 2000,
    });
  });
});
