// AcpRunner end-to-end over a real SDK client <-> the Lane D fixture agent (tests/fixtures/acp/fakeAcpAgent.mjs),
// plus a raw NDJSON agent for hang / resume / SIGTERM edge cases. No real codex-acp / hermes, no network.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpFixtureLauncher, type FakeAcpProfile } from '../../src/main/fixtures/acpFixtureLaunchers';
import {
  createMemoryStore,
  createMemoryThreadLog,
  createRecordingBroadcaster,
  makeThread,
} from '../../src/main/fixtures/memoryDeps';
import { AcpConnection } from '../../src/main/acp/acpConnection';
import type { AcpLauncher } from '../../src/main/contracts';
import { AcpRunner, type AcpRunnerTimeouts } from '../../src/main/session/acpRunner';
import { createPermissionBroker } from '../../src/main/session/permissionBroker';
import type { AssistantTextItem, ChatEvent, ChatItem, Thread, ToolItem } from '../../src/shared/types';

const FAKE_AGENT = resolve(__dirname, '../fixtures/acp/fakeAcpAgent.mjs');

// Raw agent: RAW_MODE=no-init (initialize never answered) | hang-prompt (prompt never answered, cancel ignored)
// | resume (no load, resume only) | hang-load (load never answered) | drop-stdout (stdout closed after a prompt,
// the process stays) | err-prompt (prompt answered with an error carrying secrets). RAW_IGNORE_TERM=1 ignores SIGTERM. Logs handled methods to stderr.
const RAW_AGENT = `
const mode = process.env.RAW_MODE || 'ok';
if (process.env.RAW_IGNORE_TERM) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(m) {
  process.stderr.write('METHOD ' + m.method + (m.params && m.params.sessionId ? ' ' + m.params.sessionId : '') + '\\n');
  if (m.method === 'initialize') {
    if (mode === 'no-init') return;
    const caps = mode === 'resume' ? { loadSession: false, sessionCapabilities: { resume: {} } } : mode === 'hang-load' ? { loadSession: true } : {};
    send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: caps } });
  } else if (m.method === 'session/new') {
    send({ id: m.id, result: { sessionId: 'raw-new' } });
  } else if (m.method === 'session/load' && mode === 'hang-load') {
    return;
  } else if (m.method === 'session/resume') {
    send({ id: m.id, result: {} });
  } else if (m.method === 'session/prompt') {
    if (mode === 'hang-prompt') return;
    if (mode === 'err-prompt') return send({ id: m.id, error: { code: -32603, message: 'upstream failed: api_key=plainsecret Bearer abc.def ghp_abcdefghijkl' } });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
    if (mode === 'drop-stdout') setTimeout(() => process.stdout.end(), 50);
  } else if (m.id !== undefined) {
    send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
}
`;

const FAST: Partial<AcpRunnerTimeouts> = { initialize: 10_000, open: 10_000, control: 5_000, cancelGrace: 5_000 };

let dir: string | undefined;
const runners: AcpRunner[] = [];

function tmp(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'hopecode-acprunner-'));
  return dir;
}

afterEach(async () => {
  for (const r of runners.splice(0)) r.abort();
  await new Promise((r) => setTimeout(r, 50));
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

interface SetupOptions {
  profile?: FakeAcpProfile;
  thread?: Partial<Thread>;
  env?: Record<string, string>;
  launcher?: AcpLauncher;
  timeouts?: Partial<AcpRunnerTimeouts>;
}

function setup(opts: SetupOptions = {}) {
  const profile = opts.profile ?? 'codex';
  const agent = profile === 'hermes' ? 'hermes' : 'codex';
  const cwd = join(tmp(), 'work');
  mkdirSync(cwd, { recursive: true });
  const stateDir = join(tmp(), 'state');
  const store = createMemoryStore({
    threads: [
      makeThread('t1', {
        agent,
        cwd,
        model: agent === 'codex' ? 'gpt-6-sol' : '',
        effort: agent === 'codex' ? 'high' : null,
        ...opts.thread,
      }),
    ],
    settings: { idleCloseMinutes: 0 } as never,
  });
  const threadLog = createMemoryThreadLog();
  const broadcaster = createRecordingBroadcaster();
  const broker = createPermissionBroker({ broadcaster });
  const problems: string[] = [];
  const conns: AcpConnection[] = [];
  /** Per spawn: were all earlier connections' processes gone already (turns wait for closes)? */
  const priorGoneAtSpawn: boolean[] = [];
  const launcher = opts.launcher ?? createAcpFixtureLauncher({ profile, scriptPath: FAKE_AGENT, stateDir, env: opts.env });
  const make = () => {
    const r = new AcpRunner('t1', {
      agent,
      launcher,
      store,
      threadLog,
      broadcaster,
      broker,
      appVersion: '0.0.0-test',
      onAgentProblem: (a) => problems.push(a),
      connect: (o) => {
        priorGoneAtSpawn.push(conns.every((x) => x.isGone));
        const c = new AcpConnection(o);
        conns.push(c);
        return c;
      },
      timeouts: { ...FAST, ...opts.timeouts },
      now: Date.now,
      log: () => {},
    });
    runners.push(r);
    return r;
  };
  const runner = make();
  const events = () => broadcaster.of('chat:event').map((e) => e.event);
  const thread = () => store.getThread('t1')!;
  return { runner, make, store, threadLog, broadcaster, broker, events, thread, cwd, stateDir, problems, conns, priorGoneAtSpawn };
}

function rawLauncher(env: Record<string, string>): AcpLauncher {
  const path = join(tmp(), 'rawAgent.cjs');
  writeFileSync(path, RAW_AGENT);
  return {
    resolve: () => ({ ok: true, spec: { command: process.execPath, args: [path], env: { PATH: process.env.PATH ?? '', ...env } } }),
  };
}

async function turn(runner: AcpRunner, text: string, images?: Parameters<AcpRunner['send']>[1]) {
  const res = await runner.send(text, images);
  expect(res).toEqual({ accepted: true });
  await runner.whenSettled();
}

function items(events: ChatEvent[]): ChatItem[] {
  const byId = new Map<string, ChatItem>();
  for (const e of events) if (e.type === 'item-upsert') byId.set(e.item.id, e.item);
  return [...byId.values()];
}

function texts(events: ChatEvent[]): string[] {
  return items(events)
    .filter((i): i is AssistantTextItem => i.type === 'assistant-text')
    .map((i) => i.text);
}

function tools(events: ChatEvent[]): ToolItem[] {
  return items(events).filter((i): i is ToolItem => i.type === 'tool');
}

function notices(events: ChatEvent[]): string[] {
  return items(events)
    .filter((i) => i.type === 'notice')
    .map((i) => (i as { text: string }).text);
}

function turnEnds(events: ChatEvent[]) {
  return events.filter((e) => e.type === 'turn-end');
}

/** `[whoami]` / `/config` JSON the fixture agent answers with. */
function reported(events: ChatEvent[], prefix: 'WHOAMI' | 'CONFIG'): Record<string, unknown> {
  const t = texts(events).filter((x) => x.startsWith(prefix)).at(-1);
  if (!t) throw new Error(`no ${prefix} reply`);
  return JSON.parse(t.slice(prefix.length + 1)) as Record<string, unknown>;
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('AcpRunner (codex profile)', () => {
  it('send: user item, streamed text, turn-end ok, session id and controls stored', async () => {
    const s = setup();
    await turn(s.runner, 'hello there');
    const ev = s.events();
    expect(ev[1]).toEqual({ type: 'turn-start' });
    expect(items(ev)[0]).toMatchObject({ type: 'user', text: 'hello there' });
    expect(ev.some((e) => e.type === 'text-delta')).toBe(true);
    expect(texts(ev)).toEqual(['FAKE-ACP(codex): hello there']);
    expect(turnEnds(ev)).toEqual([{ type: 'turn-end', ok: true }]);
    expect(s.thread().status).toBe('idle');
    expect(s.thread().acp?.sessionId).toMatch(/^fake-/);
    expect(s.thread().acp?.controls?.modes.map((m) => m.id)).toEqual(['read-only', 'auto', 'full-access']);
    expect(s.thread().acp?.controls?.currentModeId).toBe('auto');
    expect(s.broadcaster.of('agent:controls').length).toBeGreaterThan(0);
    // Persisted: user + assistant text.
    const logged = s.threadLog.items.get('t1') ?? [];
    expect(logged.map((i) => i.type)).toEqual(['user', 'assistant-text']);
  });

  it('busy while a turn runs; agent-unavailable when the launcher cannot resolve', async () => {
    const s = setup();
    const first = s.runner.send('/slow');
    expect(await first).toEqual({ accepted: true });
    expect(await s.runner.send('again')).toEqual({ accepted: false, reason: 'busy' });
    await s.runner.interrupt();
    await s.runner.whenSettled();

    const u = setup({ launcher: { resolve: () => ({ ok: false, reason: 'not-installed' }) } });
    expect(await u.runner.send('hi')).toEqual({ accepted: false, reason: 'agent-unavailable' });
    expect(u.events()).toEqual([]);
  });

  it('/tool and /diff: tool items with result and whole-file diffs', async () => {
    const s = setup();
    await turn(s.runner, '/tool');
    const [read] = tools(s.events());
    expect(read).toMatchObject({ name: 'Read', toolUseId: 'tool-1-1', result: '# fake README\nfixture tool output' });
    expect(read!.input).toMatchObject({ title: 'Read README.md', kind: 'read' });

    await turn(s.runner, '/diff');
    const edit = tools(s.events()).find((t) => t.name === 'Edit')!;
    expect(edit.diffs).toEqual([{ path: join(s.cwd, 'fake-acp-edit.txt'), oldText: '', newText: 'fake acp edit 2\n' }]);
    expect(readFileSync(join(s.cwd, 'fake-acp-edit.txt'), 'utf8')).toBe('fake acp edit 2\n');
    // Item ids are namespaced per connection so they never collide with an earlier connection's.
    expect(edit.id).toMatch(/^[0-9a-f]{8}:tool-/);
  });

  it('/plan: one TodoWrite card per turn, updated in place', async () => {
    const s = setup();
    await turn(s.runner, '/plan');
    const plans = tools(s.events()).filter((t) => t.name === 'TodoWrite');
    expect(plans).toHaveLength(1);
    expect(plans[0]!.result).toBe('[x] Inspect\n[x] Change\n[x] Verify');
  });

  it('/permission: allow -> completed, deny -> failed', async () => {
    const s = setup();
    const sent = s.runner.send('/permission');
    await waitFor(() => s.broker.pending().length === 1);
    const req = s.broker.pending()[0]!;
    expect(req).toMatchObject({ threadId: 't1', agent: 'codex', toolName: 'Bash', hasSessionSuggestion: true });
    expect(req.agentOptions?.map((o) => o.optionId)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    s.broker.respond(req.requestId, 'allow');
    await sent;
    await s.runner.whenSettled();
    expect(texts(s.events()).at(-1)).toBe('permission: allow_once');
    expect(tools(s.events())[0]).toMatchObject({ result: 'fixture' });

    const again = s.runner.send('/permission');
    await waitFor(() => s.broker.pending().length === 1);
    s.broker.respond(s.broker.pending()[0]!.requestId, 'deny');
    await again;
    await s.runner.whenSettled();
    expect(texts(s.events()).at(-1)).toBe('permission: reject_once');
    expect(tools(s.events()).at(-1)).toMatchObject({ isError: true, result: 'rejected' });
  });

  it('Stop during a pending permission: request answered cancelled, turn interrupted', async () => {
    const s = setup();
    await s.runner.send('/permission');
    await waitFor(() => s.broker.pending().length === 1);
    await s.runner.interrupt();
    await s.runner.whenSettled();
    expect(s.broker.pending()).toEqual([]);
    expect(s.broadcaster.of('permission:cancel')).toHaveLength(1);
    expect(turnEnds(s.events()).at(-1)).toEqual({ type: 'turn-end', ok: false, reason: 'interrupted' });
    expect(tools(s.events())[0]).toMatchObject({ isError: true });
    expect(s.thread().status).toBe('idle');
  });

  it('Stop sends session/cancel: /slow ends cancelled and the session stays usable', async () => {
    const s = setup();
    await s.runner.send('/slow');
    await waitFor(() => s.events().some((e) => e.type === 'text-delta'));
    await s.runner.interrupt();
    await s.runner.whenSettled();
    expect(turnEnds(s.events())).toEqual([{ type: 'turn-end', ok: false, reason: 'interrupted' }]);
    const sessionId = s.thread().acp?.sessionId;
    await turn(s.runner, 'after stop');
    expect(texts(s.events()).at(-1)).toBe('FAKE-ACP(codex): after stop');
    expect(s.thread().acp?.sessionId).toBe(sessionId);
  });

  it('crash: error notice with redacted stderr, idle; the next send restarts and loads the session', async () => {
    const s = setup();
    await turn(s.runner, 'first');
    const sessionId = s.thread().acp?.sessionId;
    await turn(s.runner, '/crash');
    const ev = s.events();
    expect(turnEnds(ev).at(-1)).toEqual({ type: 'turn-end', ok: false, reason: 'error' });
    const err = ev.filter((e) => e.type === 'error').at(-1) as { message: string };
    expect(err.message).toContain('Codex 프로세스가 종료되었습니다');
    expect(err.message).toContain('fatal: token');
    expect(JSON.stringify(ev)).not.toContain('FAKESECRET0123456789');
    expect(JSON.stringify([...s.threadLog.items.values()])).not.toContain('FAKESECRET0123456789');
    expect(s.thread().status).toBe('idle');

    const before = s.events().length;
    await turn(s.runner, '[whoami]');
    const after = s.events().slice(before);
    expect(reported(after, 'WHOAMI').sessionId).toBe(sessionId);
    // Replayed history is not rendered again: only the new user item + reply.
    expect(items(after).map((i) => i.type)).toEqual(['user', 'assistant-text']);
    expect(notices(after)).toEqual([]);
  });

  it('restart: a new runner loads the saved session (modes present) and drops the replay', async () => {
    const s = setup();
    await turn(s.runner, 'remember me');
    await s.runner.close();
    const sessionId = s.thread().acp?.sessionId;

    const next = s.make();
    const before = s.events().length;
    await turn(next, '[whoami]');
    const after = s.events().slice(before);
    expect(reported(after, 'WHOAMI').sessionId).toBe(sessionId);
    expect(items(after).map((i) => i.type)).toEqual(['user', 'assistant-text']);
    expect(texts(after).some((t) => t.includes('remember me'))).toBe(false);
  });

  it('load of an empty saved session (modes present, replay 0) is a normal load', async () => {
    const s = setup({ thread: { acp: { sessionId: 'fake-empty', controls: null } } });
    mkdirSync(s.stateDir, { recursive: true });
    writeFileSync(
      join(s.stateDir, 'fake-empty.json'),
      JSON.stringify({ sessionId: 'fake-empty', cwd: s.cwd, history: [], modeId: 'auto', model: 'gpt-6-sol', effort: 'high', configSets: [], turn: 0 }),
    );
    await turn(s.runner, '[whoami]');
    expect(reported(s.events(), 'WHOAMI').sessionId).toBe('fake-empty');
    expect(notices(s.events())).toEqual([]);
  });

  it('codex load of an unknown id (JSON-RPC error) -> new session + notice', async () => {
    const s = setup({ thread: { acp: { sessionId: 'fake-gone', controls: null } } });
    await turn(s.runner, '[whoami]');
    expect(reported(s.events(), 'WHOAMI').sessionId).not.toBe('fake-gone');
    expect(s.thread().acp?.sessionId).not.toBe('fake-gone');
    expect(notices(s.events())).toEqual([
      '이전 Codex 세션을 이어갈 수 없어 새 세션으로 시작했습니다. 화면의 이전 대화는 에이전트 컨텍스트에 포함되지 않습니다.',
    ]);
  });

  it('auth required: turn-end auth with a login hint, process killed, three failures -> error', async () => {
    const s = setup({ env: { FAKE_ACP_AUTH_REQUIRED: '1' } });
    await turn(s.runner, 'one');
    expect(turnEnds(s.events())).toEqual([{ type: 'turn-end', ok: false, reason: 'auth' }]);
    expect(notices(s.events()).at(-1)).toContain('npx @openai/codex login');
    expect(s.problems).toEqual(['codex']);
    expect(s.thread().status).toBe('idle');
    await turn(s.runner, 'two');
    await turn(s.runner, 'three');
    expect(s.thread().status).toBe('error');
  });

  it('spawn failure (ENOENT): error notice and a local auth re-check', async () => {
    const s = setup({
      launcher: { resolve: () => ({ ok: true, spec: { command: join(tmp(), 'missing-agent'), args: [], env: {} } }) },
    });
    await turn(s.runner, 'hi');
    const err = s.events().find((e) => e.type === 'error') as { message: string };
    expect(err.message).toBe('Codex 실행 파일을 시작할 수 없습니다: ENOENT');
    expect(s.problems).toEqual(['codex']);
    expect(turnEnds(s.events())).toEqual([{ type: 'turn-end', ok: false, reason: 'error' }]);
  });

  it('images: sent as image blocks when the agent supports them', async () => {
    const s = setup();
    await turn(s.runner, '/image', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
    expect(texts(s.events()).at(-1)).toBe('images: 1');
    expect(items(s.events())[0]).toMatchObject({ type: 'user', images: [{ mediaType: 'image/png' }] });
  });

  it('spawn -c values already match: no set_config_option; thread model / effort kept', async () => {
    const s = setup();
    await turn(s.runner, '/config');
    const cfg = reported(s.events(), 'CONFIG');
    expect(cfg).toMatchObject({ model: 'gpt-6-sol', reasoning_effort: 'high', approval_policy: 'on-request', sandbox_mode: 'workspace-write', configSets: [] });
  });

  it('open-time reconcile: differing current values -> one set_config_option each', async () => {
    const base = createAcpFixtureLauncher({ profile: 'codex', scriptPath: FAKE_AGENT, stateDir: join(tmp(), 'state') });
    // Drop the -c model / effort arguments so the agent starts on its own defaults (gpt-6.1-sol / medium).
    const launcher: AcpLauncher = {
      resolve: (cwd, o) => base.resolve(cwd, { ...o, model: null, effort: null }),
    };
    const s = setup({ launcher });
    await turn(s.runner, '/config');
    const cfg = reported(s.events(), 'CONFIG');
    expect(cfg.configSets).toEqual([
      { configId: 'model', value: 'gpt-6-sol' },
      { configId: 'reasoning_effort', value: 'high' },
    ]);
    expect(cfg).toMatchObject({ model: 'gpt-6-sol', reasoning_effort: 'high' });
    expect(s.thread()).toMatchObject({ model: 'gpt-6-sol', effort: 'high' });
  });

  it('open-time reconcile: a model the agent does not offer -> warn notice, thread adopts the current value', async () => {
    const s = setup({ thread: { model: 'gpt-unknown' } });
    await turn(s.runner, '/config');
    expect(notices(s.events())).toEqual(['Codex가 모델 gpt-unknown을(를) 제공하지 않아 gpt-6.1-sol(으)로 실행합니다.']);
    expect(s.thread().model).toBe('gpt-6.1-sol');
    expect(reported(s.events(), 'CONFIG').configSets).toEqual([]);
  });

  it('setAgentConfig: live -> set_config_option and thread model follows; no session -> stored only', async () => {
    const s = setup();
    await s.runner.setAgentConfig('model', 'gpt-6.1-sol');
    expect(s.thread().model).toBe('gpt-6-sol'); // no controls yet: nothing to map
    await turn(s.runner, 'hi');
    await s.runner.setAgentConfig('model', 'gpt-6.1-sol');
    expect(s.thread().model).toBe('gpt-6.1-sol');
    const model = s.thread().acp?.controls?.configOptions.find((o) => o.id === 'model');
    expect(model).toMatchObject({ currentValue: 'gpt-6.1-sol' });
    await turn(s.runner, '/config');
    expect(reported(s.events(), 'CONFIG').configSets).toEqual([{ configId: 'model', value: 'gpt-6.1-sol' }]);
  });

  it('permission chip (plan 2.15): live session -> session/set_mode to the matching mode', async () => {
    const s = setup();
    await turn(s.runner, 'hi');
    await s.runner.setPermissionMode('plan');
    expect(s.thread().permissionMode).toBe('plan');
    expect(s.thread().acp?.controls?.currentModeId).toBe('read-only');
    await turn(s.runner, '/config');
    expect(reported(s.events(), 'CONFIG')).toMatchObject({ modeId: 'read-only', sandbox_mode: 'workspace-write' });
  });

  it('permission chip without a matching mode: respawn with new -c arguments, then load', async () => {
    const s = setup();
    await turn(s.runner, 'hi');
    const sessionId = s.thread().acp!.sessionId;
    s.store.patchThread('t1', { acp: { ...s.thread().acp!, controls: { ...s.thread().acp!.controls!, modes: [] } } });
    await s.runner.setPermissionMode('plan');
    await s.runner.whenSettled();
    await turn(s.runner, '[whoami]');
    const who = reported(s.events(), 'WHOAMI');
    expect(who).toMatchObject({ sessionId, sandbox_mode: 'read-only', approval_policy: 'on-request' });
  });

  it('agent-side switch to full access is reverted with set_mode (chip never escalates)', async () => {
    const s = setup();
    await turn(s.runner, '/mode'); // auto -> full-access
    expect(s.thread().permissionMode).toBe('default');
    expect(notices(s.events()).at(-1)).toContain('전체 액세스');
    await waitFor(() => s.thread().acp?.controls?.currentModeId === 'auto');
    await turn(s.runner, '/config');
    expect(reported(s.events(), 'CONFIG').modeId).toBe('auto');
    expect(s.conns).toHaveLength(1);
  });

  it('a full-access revert that fails kills the agent; the next send respawns', async () => {
    const s = setup({ env: { FAKE_ACP_SET_MODE_FAIL: '1' } });
    await turn(s.runner, 'hi');
    await s.runner.send('/mode'); // auto -> full-access; the revert set_mode fails
    await s.runner.whenSettled();
    expect((await s.conns[0]!.exited).signal).toBe('SIGKILL');
    expect(notices(s.events()).some((n) => n.includes('전체 액세스'))).toBe(true);
    await s.runner.send('again');
    await s.runner.whenSettled();
    expect(s.conns).toHaveLength(2);
    // Never prompted in full access: the loaded session could not leave it, so the open failed.
    expect(texts(s.events()).some((t) => t.includes('again'))).toBe(false);
  });

  it('a session that opens in full access is switched back before the first prompt (unless bypass is confirmed)', async () => {
    for (const permissionMode of ['default', 'bypassPermissions'] as const) {
      const s = setup({ thread: { permissionMode, acp: { sessionId: 'fake-full', controls: null } } });
      mkdirSync(s.stateDir, { recursive: true });
      writeFileSync(
        join(s.stateDir, 'fake-full.json'),
        JSON.stringify({ sessionId: 'fake-full', cwd: s.cwd, history: [], modeId: 'full-access', model: 'gpt-6-sol', effort: 'high', configSets: [], turn: 0 }),
      );
      await turn(s.runner, '[whoami]');
      const expected = permissionMode === 'default' ? 'auto' : 'full-access';
      expect(reported(s.events(), 'WHOAMI').modeId).toBe(expected);
      expect(notices(s.events()).some((n) => n.includes('전체 액세스 모드'))).toBe(permissionMode === 'default');
      s.runner.abort();
      rmSync(s.stateDir, { recursive: true, force: true });
    }
  });

  it('with a confirmed bypass the full-access mode stays; an agent switch to read-only mirrors to plan', async () => {
    const s = setup({ thread: { permissionMode: 'bypassPermissions' } });
    await turn(s.runner, '/mode'); // full-access (spawned with danger-full-access) -> read-only
    expect(s.thread().permissionMode).toBe('plan');
    expect(notices(s.events())).toEqual([]);
  });

  it('permission change while initialize is pending: set_mode before the first prompt (H1)', async () => {
    const s = setup({ env: { FAKE_ACP_INIT_DELAY_MS: '300' } });
    expect(await s.runner.send('[whoami]')).toEqual({ accepted: true });
    await waitFor(() => s.conns.length === 1);
    await s.runner.setPermissionMode('plan'); // initialize pending: spawned with the old -c, no live session yet
    await s.runner.whenSettled();
    expect(reported(s.events(), 'WHOAMI')).toMatchObject({ modeId: 'read-only' });
    expect(s.thread().acp?.controls?.currentModeId).toBe('read-only');
    expect(s.conns).toHaveLength(1);
  });


  it('permission still not applied after the one respawn: no prompt, error notice, turn ends error', async () => {
    const s = setup({ env: { FAKE_ACP_INIT_DELAY_MS: '300', FAKE_ACP_SET_MODE_FAIL: '1' } });
    expect(await s.runner.send('[whoami]')).toEqual({ accepted: true });
    await waitFor(() => s.conns.length === 1);
    await s.runner.setPermissionMode('plan'); // open #1 (default): set_mode fails -> respawn with plan
    await waitFor(() => s.conns.length === 2);
    await s.runner.setPermissionMode('bypassPermissions'); // open #2 (plan, loaded in auto): set_mode fails again
    await s.runner.whenSettled();
    expect(s.conns).toHaveLength(2);
    expect(texts(s.events()).some((t) => t.startsWith('WHOAMI'))).toBe(false);
    expect(turnEnds(s.events()).at(-1)).toEqual({ type: 'turn-end', ok: false, reason: 'error' });
    expect((s.events().find((e) => e.type === 'error') as { message: string }).message).toContain('권한 설정을 적용하지 못해');
    // The next send respawns with the thread's permission.
    await turn(s.runner, '[whoami]');
    expect(reported(s.events(), 'WHOAMI')).toMatchObject({ sandbox_mode: 'danger-full-access' });
  });

  it('a send right after a queued close starts only after that close finished (M2)', async () => {
    const s = setup();
    await turn(s.runner, 'hi');
    s.store.patchThread('t1', { acp: { ...s.thread().acp!, controls: { ...s.thread().acp!.controls!, modes: [] } } });
    await s.runner.setPermissionMode('plan'); // no matching mode, idle: close queued
    await turn(s.runner, '[whoami]');
    expect(s.conns).toHaveLength(2);
    expect(s.priorGoneAtSpawn).toEqual([true, true]);
    expect(reported(s.events(), 'WHOAMI')).toMatchObject({ sandbox_mode: 'read-only' });
  });

  it('a late reasoning effort outside Claude\'s set (ultra) is kept on the thread', async () => {
    const s = setup();
    await turn(s.runner, 'hi');
    await s.runner.setAgentConfig('reasoning_effort', 'ultra');
    expect(s.thread().effort).toBe('ultra');
    expect(s.thread().acp?.controls?.configOptions.find((o) => o.id === 'approval_preset')).toMatchObject({ category: 'mode' });
  });
});

describe('AcpRunner (hermes profile)', () => {
  it('reports models.currentModelId, sends no set_config_option, tracks usage_update as ctx %', async () => {
    const s = setup({ profile: 'hermes' });
    await turn(s.runner, '/config');
    expect(s.thread().acp?.controls).toMatchObject({ reportedModel: 'og/deepseek-fixture', configOptions: [], currentModeId: 'default' });
    expect(reported(s.events(), 'CONFIG').configSets).toEqual([]);
    expect(s.thread().ctxPercent).toBeCloseTo((1000 / 128000) * 100);
  });

  it('unknown session id: load answers null ({} via the SDK, no modes) -> new session + notice', async () => {
    const s = setup({ profile: 'hermes', thread: { acp: { sessionId: 'fake-missing', controls: null } } });
    await turn(s.runner, '[whoami]');
    expect(reported(s.events(), 'WHOAMI').sessionId).not.toBe('fake-missing');
    expect(notices(s.events())).toEqual([
      '이전 Hermes 세션을 이어갈 수 없어 새 세션으로 시작했습니다. 화면의 이전 대화는 에이전트 컨텍스트에 포함되지 않습니다.',
    ]);
  });

  it('"이 세션 동안 허용" picks allow_session (not the permanent allow_always)', async () => {
    const s = setup({ profile: 'hermes' });
    await s.runner.send('/permission');
    await waitFor(() => s.broker.pending().length === 1);
    const req = s.broker.pending()[0]!;
    expect(req).toMatchObject({ agent: 'hermes', hasSessionSuggestion: true, sessionLabel: 'Allow for session' });
    s.broker.respond(req.requestId, 'allow-session');
    await s.runner.whenSettled();
    expect(texts(s.events()).at(-1)).toBe('permission: allow_session');
  });

  it('setAgentMode: remembered without a session, applied right after the next open; live -> set_mode', async () => {
    const s = setup({ profile: 'hermes' });
    await s.runner.setAgentMode('accept_edits');
    expect(s.thread().acp?.pendingModeId).toBe('accept_edits');
    await turn(s.runner, '/config');
    expect(reported(s.events(), 'CONFIG').modeId).toBe('accept_edits');
    expect(s.thread().acp?.pendingModeId).toBeNull();
    expect(s.thread().acp?.controls?.currentModeId).toBe('accept_edits');

    await s.runner.setAgentMode('dont_ask');
    await turn(s.runner, '/config');
    expect(reported(s.events(), 'CONFIG').modeId).toBe('dont_ask');
  });

  it('agent-side switch to dont_ask is reverted unless the app chose it', async () => {
    const s = setup({ profile: 'hermes' });
    await turn(s.runner, '/mode'); // default -> accept_edits (not full access): kept
    expect(s.thread().acp?.controls?.currentModeId).toBe('accept_edits');
    await turn(s.runner, '/mode'); // accept_edits -> dont_ask: reverted
    await waitFor(() => s.thread().acp?.controls?.currentModeId === 'accept_edits');
    expect(notices(s.events()).at(-1)).toContain('전체 액세스');
    await turn(s.runner, '/config');
    expect(reported(s.events(), 'CONFIG').modeId).toBe('accept_edits');
  });

  it('a Hermes session opening in dont_ask is switched to a safe mode; a mode the app chose is kept', async () => {
    const s = setup({ profile: 'hermes', thread: { acp: { sessionId: 'fake-h', controls: null } } });
    mkdirSync(s.stateDir, { recursive: true });
    writeFileSync(
      join(s.stateDir, 'fake-h.json'),
      JSON.stringify({ sessionId: 'fake-h', cwd: s.cwd, history: [], modeId: 'dont_ask', model: 'x', effort: 'medium', configSets: [], turn: 0 }),
    );
    await turn(s.runner, '/config');
    expect(reported(s.events(), 'CONFIG').modeId).toBe('default');
    await s.runner.setAgentMode('dont_ask');
    await turn(s.runner, '/config');
    expect(reported(s.events(), 'CONFIG').modeId).toBe('dont_ask');
  });

  it('setPermissionMode only stores the value (no ACP call)', async () => {
    const s = setup({ profile: 'hermes' });
    await turn(s.runner, 'hi');
    await s.runner.setPermissionMode('plan');
    await turn(s.runner, '/config');
    expect(reported(s.events(), 'CONFIG').modeId).toBe('default');
  });
});

describe('AcpRunner (noload / raw agents)', () => {
  it('noload profile with a saved session id -> new session + notice', async () => {
    const s = setup({ profile: 'noload', thread: { acp: { sessionId: 'fake-old', controls: null } } });
    await turn(s.runner, 'hi');
    expect(texts(s.events())).toEqual(['FAKE-ACP(noload): hi']);
    expect(notices(s.events())).toHaveLength(1);
    expect(s.thread().acp?.sessionId).not.toBe('fake-old');
  });

  it('resume (agent without load): session/resume keeps the id, no notice', async () => {
    const s = setup({ launcher: rawLauncher({ RAW_MODE: 'resume' }), thread: { acp: { sessionId: 'old-id', controls: null } } });
    await turn(s.runner, 'hi');
    expect(turnEnds(s.events())).toEqual([{ type: 'turn-end', ok: true }]);
    expect(s.thread().acp?.sessionId).toBe('old-id');
    expect(notices(s.events())).toEqual([]);
  });

  it('Stop while starting (initialize pending): open aborted, process killed, turn interrupted', async () => {
    const s = setup({ launcher: rawLauncher({ RAW_MODE: 'no-init' }) });
    await s.runner.send('hi');
    await new Promise((r) => setTimeout(r, 150));
    await s.runner.interrupt();
    await s.runner.whenSettled();
    expect(turnEnds(s.events())).toEqual([{ type: 'turn-end', ok: false, reason: 'interrupted' }]);
    expect(s.thread().status).toBe('idle');
    expect(notices(s.events())).toEqual([]);
    expect((await s.conns[0]!.exited).signal).toBe('SIGKILL');
    // The next send starts a fresh process (still unanswered here) instead of reusing a half-open one.
    expect(await s.runner.send('again')).toEqual({ accepted: true });
    await waitFor(() => s.conns.length === 2);
    await s.runner.interrupt();
    await s.runner.whenSettled();
    expect((await s.conns[1]!.exited).signal).toBe('SIGKILL');
  });

  it('close() while a turn waits for the old connection to close never spawns an orphan (M1)', async () => {
    // The agent drops stdout but ignores SIGTERM: the respawn close waits the full kill grace.
    const s = setup({ launcher: rawLauncher({ RAW_MODE: 'drop-stdout', RAW_IGNORE_TERM: '1' }) });
    await turn(s.runner, 'hi');
    await waitFor(() => s.conns[0]!.isGone);
    expect(await s.runner.send('again')).toEqual({ accepted: true });
    await new Promise((r) => setTimeout(r, 200)); // runTurn is inside closeConnection (SIGTERM grace)
    await s.runner.close();
    await s.runner.whenSettled();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.conns).toHaveLength(1);
    expect((await s.conns[0]!.exited).signal).toBe('SIGKILL');
  }, 15_000);

  it('agent error text is redacted in the error event and the thread log (M-2)', async () => {
    const s = setup({ launcher: rawLauncher({ RAW_MODE: 'err-prompt' }) });
    await turn(s.runner, 'hi');
    const err = s.events().find((e) => e.type === 'error') as { message: string };
    expect(err.message).toBe('Codex 오류: upstream failed: api_key=[redacted] [redacted] [redacted]');
    const all = JSON.stringify([s.events(), [...s.threadLog.items.values()]]);
    for (const secret of ['plainsecret', 'abc.def', 'ghp_abcdefghijkl']) expect(all).not.toContain(secret);
  });

  it('load timeout: the next open skips load and starts a new session with a notice (L5)', async () => {
    const s = setup({
      launcher: rawLauncher({ RAW_MODE: 'hang-load' }),
      thread: { acp: { sessionId: 'old-id', controls: null } },
      timeouts: { open: 200 },
    });
    await turn(s.runner, 'hi');
    expect((s.events().find((e) => e.type === 'error') as { message: string }).message).toBe(
      'Codex가 응답하지 않습니다 (session/load 시간 초과).',
    );
    await turn(s.runner, 'retry');
    expect(turnEnds(s.events()).at(-1)).toEqual({ type: 'turn-end', ok: true });
    expect(s.thread().acp?.sessionId).toBe('raw-new');
    expect(notices(s.events()).at(-1)).toContain('시간이 초과되어 새 세션으로 시작했습니다');
  });

  it('open timeout: process killed, error notice, connection not reused', async () => {
    const s = setup({ launcher: rawLauncher({ RAW_MODE: 'no-init' }), timeouts: { initialize: 150 } });
    await turn(s.runner, 'hi');
    const err = s.events().find((e) => e.type === 'error') as { message: string };
    expect(err.message).toBe('Codex가 응답하지 않습니다 (initialize 시간 초과).');
    expect(s.thread().status).toBe('idle');
    expect((await s.conns[0]!.exited).signal).toBe('SIGKILL');
    await turn(s.runner, 'retry');
    expect(s.conns).toHaveLength(2);
  });

  it('cancel ignored: killed after the grace period, turn interrupted, session id kept', async () => {
    const s = setup({ launcher: rawLauncher({ RAW_MODE: 'hang-prompt' }), timeouts: { cancelGrace: 200 } });
    await s.runner.send('hi');
    await waitFor(() => s.thread().acp?.sessionId === 'raw-new');
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await s.runner.interrupt();
    await s.runner.whenSettled();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(turnEnds(s.events())).toEqual([{ type: 'turn-end', ok: false, reason: 'interrupted' }]);
    expect(s.events().filter((e) => e.type === 'error')).toEqual([]);
    expect(s.thread().acp?.sessionId).toBe('raw-new');
  });

  it('dispose close: no session/close, done within ~1s even when the agent ignores SIGTERM', async () => {
    const s = setup({ launcher: rawLauncher({ RAW_IGNORE_TERM: '1' }) });
    await turn(s.runner, 'hi');
    const started = Date.now();
    await s.runner.close({ dispose: true });
    expect(Date.now() - started).toBeLessThanOrEqual(1150);
    expect((await s.conns[0]!.exited).signal).toBe('SIGKILL');
    expect(s.conns[0]!.stderrTail()).not.toContain('METHOD session/close');
  });

  it('close() while prompting: the turn settles without error events', async () => {
    const s = setup();
    await s.runner.send('/slow');
    await waitFor(() => s.events().some((e) => e.type === 'text-delta'));
    await s.runner.close();
    await s.runner.whenSettled();
    expect(s.events().filter((e) => e.type === 'error')).toEqual([]);
    expect(await s.runner.send('late')).toEqual({ accepted: false, reason: 'busy' });
    expect(existsSync(s.cwd)).toBe(true);
  });
});
