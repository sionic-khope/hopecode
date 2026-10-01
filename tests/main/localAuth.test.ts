import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DecodeJwtClaimsFn } from '../../src/core/acpTypes';
import type { LocalAuthInfo } from '../../src/shared/types';
import { detectClaude } from '../../src/main/agents/localAuth/claudeDetector';
import { detectCodex } from '../../src/main/agents/localAuth/codexDetector';
import { detectHermes, spawnInitializeProbe } from '../../src/main/agents/localAuth/hermesDetector';
import { createLocalAuthService } from '../../src/main/agents/localAuth/localAuthService';
import type { DetectorDeps, RunCommand } from '../../src/main/agents/localAuth/detectorDeps';
import { createFixtureLocalAuth } from '../../src/main/fixtures/fixtureLocalAuth';

const NOW = 1_800_000_000_000;
const SECRET_ID = 'eyJSECRET.ID.TOKEN-VALUE';
const SECRET_ACCESS = 'ACCESS-TOKEN-SECRET-VALUE';
const SECRET_KEY = 'sk-SECRETKEY1234567890';

function deps(over: Partial<DetectorDeps> = {}): DetectorDeps {
  return {
    runCommand: async () => ({ code: 1, stdout: '', stderr: '' }),
    readFile: async () => {
      throw new Error('ENOENT');
    },
    homedir: () => '/fake/home',
    now: () => NOW,
    ...over,
  };
}
const files = (m: Record<string, string>): DetectorDeps['readFile'] => async (p) => {
  if (p in m) return m[p] as string;
  throw new Error('ENOENT');
};

describe('claude detector', () => {
  const mk = (stdout: string, code = 0, path: () => string = () => '/bin/claude') => {
    const run = vi.fn<RunCommand>(async () => ({ code, stdout, stderr: '' }));
    const childEnv = vi.fn(() => ({ PATH: '/x' }));
    return { run, childEnv, d: { ...deps({ runCommand: run }), claudePath: path, childEnv } };
  };
  it('logged-in; no CLAUDE_CONFIG_DIR injected', async () => {
    const { run, childEnv, d } = mk(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', subscriptionType: 'max' }));
    const r = await detectClaude(d);
    expect(r).toMatchObject({ state: 'logged-in', method: 'claude.ai', email: 'a@b.c', plan: 'max' });
    expect(childEnv).toHaveBeenCalledWith({});
    expect(run.mock.calls[0]?.[1]).toEqual(['auth', 'status', '--json']);
  });
  it('logged-out, unsupported method, garbage, not installed', async () => {
    expect((await detectClaude(mk(JSON.stringify({ loggedIn: false })).d)).state).toBe('logged-out');
    expect((await detectClaude(mk(JSON.stringify({ loggedIn: true, authMethod: 'api' })).d)).detail).toBe('unsupported-auth-method');
    expect((await detectClaude(mk('not json', 1).d)).state).toBe('error');
    const ni = await detectClaude(mk('', 0, () => { throw new Error('x'); }).d);
    expect(ni.state).toBe('not-installed');
  });
});

describe('codex detector', () => {
  const claims: DecodeJwtClaimsFn = (jwt) =>
    jwt === SECRET_ID ? { email: 'me@x.io', plan: 'plus', exp: NOW / 1000 + 1000 } : null;
  const ENGINE = { path: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', version: '0.159.2' };
  const mk = (
    m: Record<string, string>,
    env: Record<string, string> = {},
    path: string | null = '/bin/codex-acp',
    decode = claims,
    engine: { path: string; version: string } | null = ENGINE,
  ) => ({
    ...deps({ readFile: files(m) }),
    codexAcpPath: () => path,
    codexEngine: async () => engine,
    env: () => env,
    decodeJwtClaims: decode,
  });
  const auth = (o: object) => JSON.stringify(o);

  it('chatgpt: JWT email/plan, no token leak', async () => {
    const r = await detectCodex(
      mk({ '/fake/home/.codex/auth.json': auth({ auth_mode: 'chatgpt', tokens: { id_token: SECRET_ID, access_token: SECRET_ACCESS, refresh_token: 'r' } }) }),
    );
    expect(r).toMatchObject({ state: 'logged-in', method: 'chatgpt', email: 'me@x.io', plan: 'plus', detail: null });
    expect(r).toMatchObject({ enginePath: ENGINE.path, version: '0.159.2' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
  it('no Codex engine (ChatGPT.app / codex CLI) -> not-installed with an install hint', async () => {
    const r = await detectCodex(mk({ '/fake/home/.codex/auth.json': auth({ tokens: { id_token: SECRET_ID } }) }, {}, '/bin/codex-acp', claims, null));
    expect(r).toMatchObject({ state: 'not-installed', enginePath: null, email: null });
    expect(r.detail).toContain('ChatGPT 앱 또는 Codex CLI');
    expect(r.detail).toContain('0.150.0');
  });
  it('an unusable Settings override -> not-installed with the override reason (no auto-detected engine)', async () => {
    const r = await detectCodex({ ...mk({}, {}, '/bin/codex-acp', claims, null), codexEngineError: () => '실행 가능한 파일이 아닙니다' });
    expect(r).toMatchObject({ state: 'not-installed', enginePath: null });
    expect(r.detail).toContain('설정의 Codex 실행 파일 경로를 사용할 수 없습니다: 실행 가능한 파일이 아닙니다');
  });
  it('respects CODEX_HOME', async () => {
    const r = await detectCodex(
      mk({ '/c/home/auth.json': auth({ tokens: { id_token: SECRET_ID } }) }, { CODEX_HOME: '/c/home' }),
    );
    expect(r.state).toBe('logged-in');
    expect(r.source).toBe('/c/home/auth.json');
  });
  it('expired / unreadable id_token are codes only', async () => {
    const exp = await detectCodex(
      mk({ '/fake/home/.codex/auth.json': auth({ tokens: { id_token: SECRET_ID } }) }, {}, '/b', () => ({ email: 'e', plan: null, exp: 1 })),
    );
    expect(exp).toMatchObject({ state: 'logged-in', detail: 'id-token-expired' });
    const bad = await detectCodex(
      mk({ '/fake/home/.codex/auth.json': auth({ tokens: { id_token: 'garbage' } }) }),
    );
    expect(bad).toMatchObject({ state: 'logged-in', detail: 'id-token-unreadable', email: null });
  });
  it('API key mode', async () => {
    const r = await detectCodex(mk({ '/fake/home/.codex/auth.json': auth({ auth_mode: 'apikey', OPENAI_API_KEY: SECRET_KEY }) }));
    expect(r).toMatchObject({ state: 'logged-in', method: 'api-key', plan: 'API key', email: null });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    const viaEnv = await detectCodex(mk({}, { OPENAI_API_KEY: SECRET_KEY }));
    expect(viaEnv).toMatchObject({ state: 'logged-in', method: 'api-key', plan: 'API key' });
    expect(JSON.stringify(viaEnv)).not.toContain('SECRET');
  });
  it('missing file / keyring store / corrupt / empty / not installed', async () => {
    expect(await detectCodex(mk({}))).toMatchObject({ state: 'logged-out', detail: 'auth-file-missing' });
    expect(
      await detectCodex(mk({ '/fake/home/.codex/config.toml': 'cli_auth_credentials_store = "keyring"\n' })),
    ).toMatchObject({ state: 'logged-out', detail: 'keyring-store' });
    expect(await detectCodex(mk({ '/fake/home/.codex/auth.json': `{"tokens": ${SECRET_ID}` }))).toMatchObject({
      state: 'error',
      detail: 'auth-file-unreadable',
    });
    expect(await detectCodex(mk({ '/fake/home/.codex/auth.json': '[]' }))).toMatchObject({ state: 'error' });
    expect(await detectCodex(mk({ '/fake/home/.codex/auth.json': '{}' }))).toMatchObject({ state: 'logged-out', detail: 'no-credentials' });
    expect((await detectCodex(mk({}, {}, null))).state).toBe('not-installed');
  });
  it('error text never contains the token even when decode throws is avoided', async () => {
    const r = await detectCodex(mk({ '/fake/home/.codex/auth.json': auth({ tokens: { id_token: SECRET_ID, access_token: SECRET_ACCESS } }) }));
    expect(JSON.stringify(r)).not.toContain(SECRET_ACCESS);
    expect(JSON.stringify(r)).not.toContain(SECRET_ID);
  });
});

describe('hermes detector', () => {
  const script = (map: Record<string, { code?: number; stdout?: string }>): RunCommand => async (_f, args) => {
    const r = map[args.join(' ')] ?? { code: 1 };
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: '' };
  };
  const happy = {
    'acp --version': { stdout: '0.21.5+4533.gabc\n' },
    'acp --check': { stdout: 'Hermes ACP check OK' },
    'auth list': { stdout: 'copilot (2 credentials):\n - x\nopenai-codex (1 credential):\n' },
    'auth status copilot': { stdout: 'copilot: logged out' },
    'auth status openai-codex': { stdout: 'openai-codex: logged in' },
  };
  const mk = (map: typeof happy | Record<string, { code?: number; stdout?: string }>, path: string | null = '/h/hermes', probe = vi.fn(async () => [{ id: 'og' }, { id: 'hermes-setup', type: 'terminal' }] as { id: string; type?: string }[] | null)) => ({
    d: { ...deps({ runCommand: script(map) }), hermesPath: () => path, env: () => ({ PATH: '/p' }), probeInitialize: probe },
    probe,
  });

  it('probe: agent authMethod -> logged-in provider', async () => {
    const { d, probe } = mk(happy);
    const r = await detectHermes(d, { probe: true });
    expect(r).toMatchObject({ state: 'logged-in', method: 'provider', provider: 'og', version: '0.21.5+4533.gabc' });
    expect(r.providers).toEqual([{ id: 'copilot', count: 2 }, { id: 'openai-codex', count: 1 }]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it('no agent method -> logged-out; probe failure falls back to auth status', async () => {
    const out = mk(happy, '/h/hermes', vi.fn(async () => [{ id: 'hermes-setup', type: 'terminal' }]));
    expect((await detectHermes(out.d, { probe: true })).state).toBe('logged-out');
    const fail = mk(happy, '/h/hermes', vi.fn(async () => null));
    expect(await detectHermes(fail.d, { probe: true })).toMatchObject({ state: 'logged-in', provider: 'openai-codex', detail: 'probe-failed' });
    const failNone = mk({ ...happy, 'auth status openai-codex': { stdout: 'openai-codex: logged out' } }, '/h/hermes', vi.fn(async () => null));
    expect((await detectHermes(failNone.d, { probe: true })).state).toBe('error');
  });
  it('probe=false reuses previous probe result without spawning', async () => {
    const { d, probe } = mk(happy);
    const prev = await detectHermes(d, { probe: true });
    probe.mockClear();
    const r = await detectHermes(d, { probe: false, prev });
    expect(probe).not.toHaveBeenCalled();
    expect(r).toMatchObject({ state: 'logged-in', provider: 'og' });
  });
  it('default model: CLI success', async () => {
    const { d } = mk({ ...happy, 'config get model.default': { stdout: 'deepseek/deepseek-v4.1-flash-ultrafast\n' }, 'config get model.provider': { stdout: 'og\n' } });
    expect(await detectHermes(d, { probe: true })).toMatchObject({ defaultModel: 'deepseek/deepseek-v4.1-flash-ultrafast', defaultProvider: 'og' });
  });
  it('default model: CLI failure falls back to config.yaml (HERMES_HOME respected)', async () => {
    const yaml = "# c\nmodel:\n  default: 'deepseek/deepseek-v4.1-flash-ultrafast'  # note\n  provider: og\n  other: x\nagent:\n  default: nope\n";
    const { d } = mk(happy);
    const read = vi.fn(async (p: string) => {
      if (p === '/fake/home/.hermes/config.yaml') return yaml;
      throw new Error('ENOENT');
    });
    expect(await detectHermes({ ...d, readFile: read }, { probe: true })).toMatchObject({ defaultModel: 'deepseek/deepseek-v4.1-flash-ultrafast', defaultProvider: 'og' });
    const custom = vi.fn(async (p: string) => {
      if (p === '/custom/hh/config.yaml') return yaml;
      throw new Error('ENOENT');
    });
    const env = () => ({ PATH: '/p', HERMES_HOME: '/custom/hh' });
    expect(await detectHermes({ ...d, env, readFile: custom }, { probe: true })).toMatchObject({ defaultModel: 'deepseek/deepseek-v4.1-flash-ultrafast' });
  });
  it('default model: CLI and yaml both fail -> null', async () => {
    const { d } = mk(happy);
    const r = await detectHermes({ ...d, readFile: async () => { throw new Error('ENOENT'); } }, { probe: true });
    expect(r).toMatchObject({ state: 'logged-in', defaultModel: null, defaultProvider: null });
  });
  it('not installed / check failure', async () => {
    expect((await detectHermes(mk(happy, null).d, { probe: true })).state).toBe('not-installed');
    expect(await detectHermes(mk({ ...happy, 'acp --check': { code: 1 } }).d, { probe: true })).toMatchObject({ state: 'error', detail: 'acp-check-failed' });
  });
  it('spawnInitializeProbe parses authMethods from a stub child (own node, no home access)', async () => {
    const src = `process.stdin.once('data',()=>{console.error('noise');process.stdout.write('log line\\n'+JSON.stringify({jsonrpc:'2.0',id:1,result:{authMethods:[{id:'custom'},{id:'hermes-setup',type:'terminal'}]}})+'\\n')})`;
    const methods = await spawnInitializeProbe(process.execPath, ['-e', src], { ...process.env } as Record<string, string>, 10_000);
    expect(methods).toEqual([{ id: 'custom' }, { id: 'hermes-setup', type: 'terminal' }]);
    expect(await spawnInitializeProbe(process.execPath, ['-e', 'process.exit(0)'], { ...process.env } as Record<string, string>, 10_000)).toBeNull();
  });
  it('spawnInitializeProbe: stdout capped at 1MB, and the whole process group is killed afterwards', async () => {
    const flood = `process.stdin.once('data',()=>{const s='x'.repeat(65536);const w=()=>{while(process.stdout.write(s));process.stdout.once('drain',w)};w()})`;
    const started = Date.now();
    expect(await spawnInitializeProbe(process.execPath, ['-e', flood], { ...process.env } as Record<string, string>, 10_000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);

    const pidFile = join(mkdtempSync(join(tmpdir(), 'hopecode-probe-')), 'grandchild.pid');
    const withChild = `const c=require('node:child_process').spawn('sleep',['30'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.stdin.once('data',()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{authMethods:[]}})+'\\n')})`;
    expect(await spawnInitializeProbe(process.execPath, ['-e', withChild], { ...process.env } as Record<string, string>, 10_000)).toEqual([]);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    const until = Date.now() + 3_000;
    while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    rmSync(dirname(pidFile), { recursive: true, force: true });
    expect(alive()).toBe(false);
  });
});

describe('localAuthService', () => {
  const info = (agent: LocalAuthInfo['agent'], state: LocalAuthInfo['state'], at: number): LocalAuthInfo => ({
    agent, state, method: null, email: null, plan: null, provider: null, source: '', version: null, detail: null, checkedAt: at,
  });
  function mk() {
    let t = 0;
    const st = { claude: 'logged-in' as LocalAuthInfo['state'] };
    const claude = vi.fn(async () => info('claude-code', st.claude, t));
    const codex = vi.fn(async () => info('codex', 'logged-out', t));
    const hermes = vi.fn(async (_o: { probe: boolean; prev: LocalAuthInfo | null }) => info('hermes', 'not-installed', t));
    const svc = createLocalAuthService({ detectors: { 'claude-code': claude, codex, hermes }, now: () => t, ttlMs: 1000 });
    return { svc, claude, codex, hermes, st, tick: (n: number) => (t += n) };
  }
  it('availability from cache, TTL, force, hermes probe only at first/force', async () => {
    const { svc, claude, hermes, tick } = mk();
    expect(svc.availability('codex').reason).toBe('error');
    await svc.recheck();
    expect(svc.availability('claude-code')).toEqual({ agent: 'claude-code', usable: true, reason: 'ok' });
    expect(svc.availability('codex').reason).toBe('not-logged-in');
    expect(svc.availability('hermes').reason).toBe('not-installed');
    expect(hermes.mock.calls[0]?.[0].probe).toBe(true);
    await svc.recheck();
    expect(claude).toHaveBeenCalledTimes(1);
    tick(2000);
    await svc.recheck();
    expect(claude).toHaveBeenCalledTimes(2);
    expect(hermes.mock.calls[1]?.[0].probe).toBe(false);
    await svc.recheck('hermes', { force: true });
    expect(hermes.mock.calls[2]?.[0].probe).toBe(true);
  });
  it('dedupes in-flight and notifies only on change', async () => {
    const { svc, claude, st, tick } = mk();
    const cb = vi.fn();
    const off = svc.onChange(cb);
    await Promise.all([svc.recheck('claude-code'), svc.recheck('claude-code')]);
    expect(claude).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    await svc.recheck('claude-code', { force: true });
    expect(cb).toHaveBeenCalledTimes(1);
    st.claude = 'logged-out';
    tick(10_000);
    await svc.recheck('claude-code', { force: true });
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    st.claude = 'logged-in';
    tick(10_000);
    await svc.recheck('claude-code', { force: true });
    expect(cb).toHaveBeenCalledTimes(2);
  });
  it('forced rechecks run at most once per agent every 10s (others answer from the cache)', async () => {
    const { svc, hermes, codex, tick } = mk();
    await svc.recheck('hermes', { force: true });
    await svc.recheck('hermes', { force: true });
    tick(9_999);
    await svc.recheck('hermes', { force: true });
    expect(hermes).toHaveBeenCalledTimes(1);
    await svc.recheck('codex', { force: true }); // per agent
    expect(codex).toHaveBeenCalledTimes(1);
    tick(1);
    await svc.recheck('hermes', { force: true });
    expect(hermes).toHaveBeenCalledTimes(2);
    expect(hermes.mock.calls.map((c) => c[0].probe)).toEqual([true, true]);
  });
  it('detector crash -> error info without message', async () => {
    const svc = createLocalAuthService({
      detectors: {
        'claude-code': async () => { throw new Error(`boom ${SECRET_KEY}`); },
        codex: async () => info('codex', 'logged-in', 0),
        hermes: async () => info('hermes', 'logged-in', 0),
      },
    });
    const list = await svc.recheck();
    expect(list.find((i) => i.agent === 'claude-code')).toMatchObject({ state: 'error', detail: 'detect-failed' });
    expect(JSON.stringify(list)).not.toContain('SECRET');
  });
});

describe('fixtureLocalAuth', () => {
  it('deterministic with HOPECODE_FIXTURE_AGENTS override', async () => {
    const svc = createFixtureLocalAuth({ HOPECODE_FIXTURE_AGENTS: 'codex:logged-out,hermes:not-installed' });
    await svc.recheck();
    expect(svc.availability('codex').reason).toBe('not-logged-in');
    expect(svc.availability('hermes').reason).toBe('not-installed');
    expect(svc.availability('claude-code').reason).toBe('not-logged-in');
    const on = createFixtureLocalAuth({ HOPECODE_FIXTURE_LOCAL_CLAUDE: '1' });
    await on.recheck();
    expect(on.availability('claude-code').usable).toBe(true);
  });
});
