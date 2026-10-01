// Lane F: SessionManager runs Codex / Hermes threads through AcpRunner with the fixture ACP agent
// (tests/fixtures/acp/fakeAcpAgent.mjs via process.execPath + ELECTRON_RUN_AS_NODE), routes mode / config calls,
// fires the agent-problem / turn-end hooks, and disposes ACP runners within the quit budget. Plus the real launcher
// table and the local-account wiring (probe env, shared-config relink filter). No real codex-acp / hermes.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpFixtureLauncher } from '../../src/main/fixtures/acpFixtureLaunchers';
import {
  createMemoryStore,
  createMemoryThreadLog,
  createMemoryUsagePoller,
  createRecordingBroadcaster,
  createStaticClaudeBinary,
  createStaticShellEnv,
  makeAccount,
  makeThread,
} from '../../src/main/fixtures/memoryDeps';
import { createFakeQuery } from '../../src/main/fixtures/fakeQuery';
import { createSessionManager, type SessionManagerImpl } from '../../src/main/session/sessionManager';
import { createAcpLaunchers } from '../../src/main/agents/acpLaunchers';
import { createSharedConfig, probeEnvInject } from '../../src/main/accounts/poolWiring';
import type { AcpLauncher } from '../../src/main/contracts';
import type { AcpAgentKind } from '../../src/core/acpTypes';
import type { ChatEvent, SharedConfigStatus, Thread } from '../../src/shared/types';

const FAKE_AGENT = resolve(__dirname, '../fixtures/acp/fakeAcpAgent.mjs');

let dir: string | undefined;
const managers: SessionManagerImpl[] = [];

afterEach(async () => {
  for (const m of managers.splice(0)) m.abortAll();
  await new Promise((r) => setTimeout(r, 50));
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(threads: Partial<Thread>[], launchers?: Partial<Record<AcpAgentKind, AcpLauncher>>) {
  dir = mkdtempSync(join(tmpdir(), 'hopecode-sm-agents-'));
  const cwd = join(dir, 'work');
  mkdirSync(cwd, { recursive: true });
  const stateDir = join(dir, 'state');
  const store = createMemoryStore({
    threads: threads.map((t, i) => makeThread(t.id ?? `t${i}`, { cwd, ...t })),
    settings: { idleCloseMinutes: 0 } as never,
  });
  const broadcaster = createRecordingBroadcaster();
  const problems: string[] = [];
  const turnEnds: string[] = [];
  const manager = createSessionManager({
    query: createFakeQuery({}).query,
    store,
    threadLog: createMemoryThreadLog(),
    listAccounts: () => [],
    usage: createMemoryUsagePoller(() => []),
    shellEnv: createStaticShellEnv(),
    claudeBinary: createStaticClaudeBinary(),
    broadcaster,
    appVersion: '0.0.0-test',
    acpLaunchers: launchers ?? {
      codex: createAcpFixtureLauncher({ profile: 'codex', scriptPath: FAKE_AGENT, stateDir }),
      hermes: createAcpFixtureLauncher({ profile: 'hermes', scriptPath: FAKE_AGENT, stateDir }),
    },
    scratchRoot: join(dir, 'scratch'),
    onAgentProblem: (agent) => problems.push(agent),
    onAcpTurnEnd: (agent) => turnEnds.push(agent),
    acpTimeouts: { initialize: 10_000, open: 10_000, control: 5_000, cancelGrace: 5_000 },
    log: () => {},
  });
  managers.push(manager);
  const events = (threadId: string): ChatEvent[] =>
    broadcaster.of('chat:event').filter((e) => e.threadId === threadId).map((e) => e.event);
  return { manager, store, broadcaster, events, problems, turnEnds };
}

const texts = (ev: ChatEvent[]) =>
  ev.flatMap((e) => (e.type === 'item-upsert' && e.item.type === 'assistant-text' ? [e.item.text] : []));

describe('SessionManager ACP runners (fixture agent)', () => {
  it('a Codex thread runs a turn through AcpRunner; the turn-end hook fires', async () => {
    const s = setup([{ id: 'c1', agent: 'codex', model: 'gpt-6-sol', effort: 'high' }]);
    expect(await s.manager.send('c1', 'hello')).toEqual({ accepted: true });
    await s.manager.whenSettled('c1');
    expect(texts(s.events('c1'))).toEqual(['FAKE-ACP(codex): hello']);
    expect(s.store.getThread('c1')?.acp?.sessionId).toMatch(/^fake-/);
    expect(s.store.getThread('c1')?.status).toBe('idle');
    expect(s.turnEnds).toEqual(['codex']);
  });

  it('a Hermes thread: setAgentMode reaches session/set_mode and updates the controls', async () => {
    const s = setup([{ id: 'h1', agent: 'hermes', model: '', effort: null }]);
    await s.manager.send('h1', 'hi');
    await s.manager.whenSettled('h1');
    const modes = s.store.getThread('h1')?.acp?.controls?.modes ?? [];
    expect(modes.length).toBeGreaterThan(1);
    const other = modes.find((m) => m.id !== s.store.getThread('h1')?.acp?.controls?.currentModeId)!;
    await s.manager.setAgentMode('h1', other.id);
    expect(s.store.getThread('h1')?.acp?.controls?.currentModeId).toBe(other.id);
  });

  it('listModels ignores ACP runners (no Claude catalog)', async () => {
    const s = setup([{ id: 'c1', agent: 'codex', model: 'gpt-6-sol', effort: 'high' }]);
    await s.manager.send('c1', 'hello');
    await s.manager.whenSettled('c1');
    expect((await s.manager.listModels()).length).toBeGreaterThan(0);
  });

  it('no launcher for the agent = agent-unavailable, nothing spawned', async () => {
    const s = setup([{ id: 'c1', agent: 'codex' }], {});
    expect(await s.manager.send('c1', 'hello')).toEqual({ accepted: false, reason: 'agent-unavailable' });
  });

  it('a scratch thread passes GIT_CEILING_DIRECTORIES=<scratch root> to the launcher', async () => {
    const seen: (string | undefined)[] = [];
    const s = setup([{ id: 'c1', agent: 'codex', projectId: null }], {
      codex: {
        resolve(_cwd, opts) {
          seen.push(opts.gitCeiling);
          return { ok: false, reason: 'not-installed' };
        },
      },
    });
    await s.manager.send('c1', 'x');
    expect(seen).toEqual([join(dir as string, 'scratch')]);
  });

  it('dispose closes ACP runners within the quit budget', async () => {
    const s = setup([{ id: 'c1', agent: 'codex', model: 'gpt-6-sol', effort: 'high' }]);
    await s.manager.send('c1', 'hello');
    await s.manager.whenSettled('c1');
    const started = Date.now();
    await s.manager.dispose();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('createAcpLaunchers (real agents)', () => {
  const binaries = (codex: string | null, hermes: string | null) => ({ resolveCodexAcp: () => codex, resolveHermes: () => hermes });
  const baseEnv = () => ({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'x', HOPECODE_FIXTURES: '1', OPENAI_API_KEY: 'k' });

  it('codex: bundled binary, `-c` overrides from the thread values, scratch ceiling, no ANTHROPIC_* / HOPECODE_*', () => {
    const l = createAcpLaunchers({ binaries: binaries('/bin/codex-acp', null), baseEnv });
    const res = l.codex.resolve('/w', { model: 'gpt-6-sol', effort: 'high', permissionMode: 'plan', gitCeiling: '/s' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.spec.command).toBe('/bin/codex-acp');
    expect(res.spec.args).toEqual([
      '-c',
      'model="gpt-6-sol"',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      'approval_policy="on-request"',
      '-c',
      'sandbox_mode="read-only"',
    ]);
    expect(res.spec.env).toEqual({ PATH: '/usr/bin', OPENAI_API_KEY: 'k', GIT_CEILING_DIRECTORIES: '/s' });
  });

  it('codex: an invalid stored model is dropped (agent default), never passed on', () => {
    const l = createAcpLaunchers({ binaries: binaries('/bin/codex-acp', null), baseEnv });
    const res = l.codex.resolve('/w', { model: 'a"b', effort: 'high', permissionMode: 'default' });
    expect(res.ok && res.spec.args.some((a) => a.startsWith('model'))).toBe(false);
  });

  it('hermes: `hermes acp`; not installed -> not-installed', () => {
    const l = createAcpLaunchers({ binaries: binaries(null, '/u/hermes'), baseEnv });
    const res = l.hermes.resolve('/w', { permissionMode: 'default' });
    expect(res.ok && [res.spec.command, res.spec.args, res.spec.env['ANTHROPIC_API_KEY']]).toEqual(['/u/hermes', ['acp'], 'x']);
    expect(l.codex.resolve('/w', { permissionMode: 'default' })).toEqual({ ok: false, reason: 'not-installed' });
  });
});

describe('local Claude account wiring (index.ts)', () => {
  it('model probe env: no CLAUDE_CONFIG_DIR for the local account, the account dir otherwise', () => {
    expect(probeEnvInject(makeAccount('l', { source: 'local-default', configDir: '/home/.claude' }), 'hopecode/1')).toEqual({
      clientApp: 'hopecode/1',
    });
    expect(probeEnvInject(makeAccount('m', { configDir: '/acc/m' }), 'hopecode/1')).toEqual({ configDir: '/acc/m', clientApp: 'hopecode/1' });
  });

  it('relink and shared-config status skip the local account', async () => {
    const accounts = [makeAccount('l', { source: 'local-default', configDir: '/home/.claude' }), makeAccount('m', { configDir: '/acc/m' })];
    const linked: string[] = [];
    const statusOf: string[][] = [];
    const shared = createSharedConfig({
      accountPool: { list: () => accounts },
      links: { linkSharedConfig: async (d) => (linked.push(d), { linked: [], skipped: [] }) },
      sourceDir: '/home/.claude',
      status: async (list) => (statusOf.push(list.map((a) => a.id)), {} as SharedConfigStatus),
    });
    await shared.status();
    await shared.relink();
    expect(linked).toEqual(['/acc/m']);
    expect(statusOf).toEqual([['m'], ['m']]);
  });
});
