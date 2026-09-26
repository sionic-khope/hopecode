import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeQuery, FAKE_MODELS } from '../../src/main/fixtures/fakeQuery';
import { createRecordingBroadcaster, makeAccount, makeThread } from '../../src/main/fixtures/memoryDeps';
import { createSessionHarness } from '../../src/main/fixtures/sessionHarness';
import { createModelCatalog, probeModels, toModelOption } from '../../src/main/models/modelCatalog';
import { createSessionManager } from '../../src/main/session/sessionManager';
import { FALLBACK_MODELS } from '../../src/shared/constants';
import type { ModelOption } from '../../src/shared/types';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hopecode-models-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const LIST: ModelOption[] = FAKE_MODELS.map(toModelOption);

describe('model catalog (models.json)', () => {
  it('starts empty, persists an update, broadcasts models:updated once per change and reloads it', async () => {
    const file = join(dir, 'models.json');
    const broadcaster = createRecordingBroadcaster();
    const catalog = createModelCatalog({ filePath: file, broadcaster, now: () => 1234 });
    await catalog.load();

    await catalog.update(LIST);
    expect(catalog.get()).toEqual(LIST);
    expect(broadcaster.of('models:updated')).toEqual([LIST]);
    await catalog.update(LIST); // unchanged: no second broadcast
    expect(broadcaster.of('models:updated')).toHaveLength(1);

    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved).toMatchObject({ version: 1, fetchedAt: 1234 });
    expect(saved.models.find((m: ModelOption) => m.value === 'default')).toMatchObject({ resolvedModel: 'claude-fable-5-1' });

    const reloaded = createModelCatalog({ filePath: file });
    await reloaded.load();
    expect(reloaded.get()).toEqual(LIST);
    expect(reloaded.fetchedAt()).toBe(1234);
  });

  it('ignores an empty report and drops malformed cached rows', async () => {
    const file = join(dir, 'models.json');
    await writeFile(file, JSON.stringify({ version: 1, fetchedAt: 1, models: [{ value: 'opus', label: 'Opus 5.5' }, { nope: true }, 7] }));
    const catalog = createModelCatalog({ filePath: file });
    await catalog.load();
    expect(catalog.get()).toEqual([{ value: 'opus', label: 'Opus 5.5' }]);
    await catalog.update([]);
    expect(catalog.get()).toEqual([{ value: 'opus', label: 'Opus 5.5' }]);
  });

  it('an unreadable cache means no catalog (fallback list), not a crash', async () => {
    const file = join(dir, 'models.json');
    await writeFile(file, '{ not json');
    const catalog = createModelCatalog({ filePath: file, log: () => {} });
    await catalog.load();
  });
});

describe('probeModels (message-less startup probe)', () => {
  it('reads the initialize answer without sending any prompt, then closes the Query', async () => {
    const fake = createFakeQuery();
    const models = await probeModels({
      query: fake.query,
      cwd: dir,
      env: { CLAUDE_CONFIG_DIR: join(dir, 'acct') },
      pathToClaudeCodeExecutable: 'claude',
    });
    expect(models).toEqual(LIST);
    const call = fake.calls[0]!;
    expect(call.initialized).toBe(true);
    expect(call.prompts).toEqual([]);
    expect(call.closed).toBe(true);
    expect(call.options).toMatchObject({ persistSession: false, settingSources: ['user'], cwd: dir });
    expect(call.configDir).toBe(join(dir, 'acct'));
  });

  it('times out (and still closes) when the CLI never answers', async () => {
    const fake = createFakeQuery();
    const hanging = ((params: Parameters<typeof fake.query>[0]) => {
      const q = fake.query(params);
      return Object.assign(q, { initializationResult: () => new Promise(() => {}) });
    }) as typeof fake.query;
    await expect(
      probeModels({ query: hanging, cwd: dir, env: {}, pathToClaudeCodeExecutable: 'claude', timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
    expect(fake.calls[0]!.closed).toBe(true);
  });
});

describe('SessionManager.listModels with the catalog', () => {
  it('uses the persisted catalog while no session is live, and writes a live report back to it', async () => {
    const catalog = createModelCatalog({ filePath: join(dir, 'models.json') });
    await catalog.load();
    const cached: ModelOption[] = [{ value: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' }];
    await catalog.update(cached);

    const h = createSessionHarness({ accounts: [makeAccount('A', { configDir: join(dir, 'A') })], threads: [makeThread('t1', { cwd: dir })] });
    const manager = createSessionManager({
      query: h.fake.query,
      store: h.store,
      threadLog: h.threadLog,
      listAccounts: () => h.accounts,
      usage: h.usage,
      shellEnv: { childEnv: (inject): Record<string, string> => (inject.configDir ? { CLAUDE_CONFIG_DIR: inject.configDir } : {}) },
      claudeBinary: { resolvePath: () => 'claude' },
      broadcaster: h.broadcaster,
      appVersion: '0.1.0',
      models: catalog,
      log: () => {},
    });
    expect(await manager.listModels()).toEqual(cached);

    await manager.send('t1', 'hi');
    await manager.whenSettled('t1');
    expect(await manager.listModels()).toEqual(LIST);
    expect(catalog.get()).toEqual(LIST);
    await manager.dispose();
  });

  it('falls back to the built-in list without a catalog or a session', async () => {
    const h = createSessionHarness({ accounts: [], threads: [] });
    expect(await h.manager.listModels()).toEqual([...FALLBACK_MODELS]);
  });
});

describe('the first live session refreshes the catalog and notifies the renderer', () => {
  it('broadcasts models:updated after session init without anyone calling models:list', async () => {
    const recorder = createRecordingBroadcaster();
    const withBroadcast = createModelCatalog({ filePath: join(dir, 'models2.json'), broadcaster: recorder });
    const h = createSessionHarness({ accounts: [makeAccount('A', { configDir: join(dir, 'A') })], threads: [makeThread('t1', { cwd: dir })] });
    const manager = createSessionManager({
      query: h.fake.query,
      store: h.store,
      threadLog: h.threadLog,
      listAccounts: () => h.accounts,
      usage: h.usage,
      shellEnv: { childEnv: (): Record<string, string> => ({}) },
      claudeBinary: { resolvePath: () => 'claude' },
      broadcaster: h.broadcaster,
      appVersion: '0.1.0',
      models: withBroadcast,
      log: () => {},
    });
    await manager.send('t1', 'hi');
    await manager.whenSettled('t1');
    await expect.poll(() => recorder.of('models:updated').length).toBe(1);
    expect(recorder.of('models:updated')[0]).toEqual(LIST);
    expect(withBroadcast.get()).toEqual(LIST);
    await manager.dispose();
  });
});
