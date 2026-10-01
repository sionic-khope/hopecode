// ThreadRunner as the Claude AgentRunner (plan 2.1), local-default env (2.9.5), Claude defaults (2.11), scratch env.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '../../src/main/contracts';
import { createFakeQuery } from '../../src/main/fixtures/fakeQuery';
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
import { createSessionHarness } from '../../src/main/fixtures/sessionHarness';
import { scratchDir } from '../../src/main/paths';
import { createPermissionBroker } from '../../src/main/session/permissionBroker';
import { ThreadRunner } from '../../src/main/session/threadRunner';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { Thread } from '../../src/shared/types';

let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopecode-runner-agents-'));
  previousHome = process.env['HOPECODE_HOME'];
  process.env['HOPECODE_HOME'] = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOPECODE_HOME'];
  else process.env['HOPECODE_HOME'] = previousHome;
  rmSync(root, { recursive: true, force: true });
});

async function firstQueryOptions(account: ReturnType<typeof makeAccount>, thread: Partial<Thread> = {}) {
  const h = createSessionHarness({
    accounts: [account],
    threads: [makeThread('t1', { cwd: join(root, 'work'), ...thread })],
  });
  expect(await h.manager.send('t1', 'hi')).toMatchObject({ accepted: true });
  await h.manager.whenSettled('t1');
  await h.manager.dispose();
  return h.fake.calls[0]!.options;
}

describe('ThreadRunner env', () => {
  it('local-default account: no CLAUDE_CONFIG_DIR in the Query env', async () => {
    const local = makeAccount('local', { source: 'local-default', configDir: join(root, 'home', 'fake-claude') });
    const options = await firstQueryOptions(local);
    expect(options.env).toBeDefined();
    expect('CLAUDE_CONFIG_DIR' in options.env!).toBe(false);
  });

  it('managed account: CLAUDE_CONFIG_DIR = its config dir', async () => {
    const managed = makeAccount('m', { configDir: join(root, 'home', 'accounts', 'm') });
    const options = await firstQueryOptions(managed);
    expect(options.env!['CLAUDE_CONFIG_DIR']).toBe(managed.configDir);
    expect('GIT_CEILING_DIRECTORIES' in options.env!).toBe(false);
  });

  it('chat without a project: GIT_CEILING_DIRECTORIES = scratch root', async () => {
    const options = await firstQueryOptions(makeAccount('m'), { projectId: null });
    expect(options.env!['GIT_CEILING_DIRECTORIES']).toBe(scratchDir());
    expect(scratchDir().startsWith(root)).toBe(true);
  });

  it('a new Claude thread with the default settings opens Opus 5.5 / high', async () => {
    const options = await firstQueryOptions(makeAccount('m'), {
      model: DEFAULT_SETTINGS.defaultModel,
      effort: DEFAULT_SETTINGS.defaultEffort,
    });
    expect(options.model).toBe('claude-opus-5-5');
    expect(options.effort).toBe('high');
  });
});

describe('ThreadRunner implements AgentRunner', () => {
  function runner(): { r: AgentRunner & ThreadRunner; send: () => Promise<unknown> } {
    const accounts = [makeAccount('m')];
    const store = createMemoryStore({ accounts, threads: [makeThread('t1', { cwd: join(root, 'work') })] });
    const broadcaster = createRecordingBroadcaster();
    const fake = createFakeQuery();
    const r = new ThreadRunner('t1', {
      query: fake.query,
      store,
      threadLog: createMemoryThreadLog(),
      listAccounts: () => accounts,
      usage: createMemoryUsagePoller(() => accounts),
      shellEnv: createStaticShellEnv(),
      claudeBinary: createStaticClaudeBinary(),
      broadcaster,
      broker: createPermissionBroker({ broadcaster, onModeChange: () => {} }),
      syncTranscript: async () => ({ found: false, copied: [] }),
      appVersion: '0.1.0',
      onWaiting: () => {},
      now: Date.now,
      log: () => {},
    });
    return { r, send: () => r.send('hi') };
  }

  it('agent is claude-code; ACP-only controls throw unsupported', async () => {
    const { r } = runner();
    expect(r.agent).toBe('claude-code');
    await expect(r.setAgentMode('default')).rejects.toThrow('unsupported');
    await expect(r.setAgentConfig('model', 'x')).rejects.toThrow('unsupported');
  });

  it('supportedModels: null without a live Query, the Query catalog while one is open', async () => {
    const { r, send } = runner();
    expect(r.supportedModels()).toBeNull();
    await send();
    await r.whenSettled();
    const models = await r.supportedModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models!.length).toBeGreaterThan(0);
    await r.close();
    expect(r.supportedModels()).toBeNull();
  });
});
