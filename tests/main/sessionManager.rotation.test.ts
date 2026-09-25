import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeScenario } from '../../src/main/fixtures/fakeQuery';
import { makeAccount, makeThread } from '../../src/main/fixtures/memoryDeps';
import { createSessionHarness, type SessionHarness } from '../../src/main/fixtures/sessionHarness';
import { CONTINUE_PROMPT, MINUTE_MS } from '../../src/shared/constants';
import type { Account, ChatEvent, ChatItem, Thread } from '../../src/shared/types';

const HOUR = 60 * MINUTE_MS;
const SID0 = '0f0e0d0c-0b0a-4908-8706-050403020100';
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hopecode-rotation-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

const encodeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function accountsFor(ids: string[]): Account[] {
  return ids.map((id, i) => makeAccount(id, { priority: i, configDir: join(root, 'accounts', id) }));
}

function setup(opts: { accounts: string[]; thread?: Partial<Thread>; scenario?: FakeScenario; settings?: { idleCloseMinutes: number } }) {
  const cwd = join(root, 'work');
  return createSessionHarness({
    accounts: accountsFor(opts.accounts),
    threads: [makeThread('t1', { cwd, ...opts.thread })],
    scenario: opts.scenario,
    writeTranscript: true,
    contextPercentage: 37,
    settings: opts.settings,
  });
}

function transcriptPath(h: SessionHarness, accountId: string, sid: string): string {
  const account = h.accounts.find((a) => a.id === accountId)!;
  return join(account.configDir, 'projects', encodeCwd(h.thread('t1').cwd), `${sid}.jsonl`);
}

async function readTranscript(h: SessionHarness, accountId: string, sid: string): Promise<{ writer: string; type: string; text?: string }[]> {
  const raw = await readFile(transcriptPath(h, accountId, sid), 'utf8');
  return raw.trim().split('\n').map((l) => JSON.parse(l));
}

function exhausted(resetsAt: number) {
  return { fiveHour: { percent: 100, resetsAt }, fetchedAt: Date.now(), stale: false };
}

function chatEvents(h: SessionHarness): ChatEvent[] {
  return h.broadcaster.of('chat:event').map((e) => e.event);
}

function notices(h: SessionHarness): string[] {
  return chatEvents(h)
    .filter((e): e is Extract<ChatEvent, { type: 'item-upsert' }> => e.type === 'item-upsert')
    .map((e) => e.item)
    .filter((i): i is Extract<ChatItem, { type: 'notice' }> => i.type === 'notice')
    .map((i) => i.text);
}

const rejected = (resetsAtSec = Math.floor(Date.now() / 1000) + 3600) =>
  ({ type: 'rateLimit', info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetsAtSec } }) as const;

describe('SessionManager rotation (plan 7.2)', () => {
  it('(a) rejected without output -> original prompt resent on B with same resume sid; lastAccountId unchanged', async () => {
    const h = setup({
      accounts: ['C', 'A', 'B'],
      thread: { sdkSessionId: SID0, lastAccountId: 'C' },
      scenario: ({ callIndex }) => (callIndex === 0 ? [rejected()] : [{ type: 'text', text: 'answer from B' }]),
    });
    // C holds the freshest transcript but is exhausted now.
    h.usage.set('C', exhausted(Date.now() + HOUR));
    const cDir = join(h.accounts[0]!.configDir, 'projects', encodeCwd(h.thread('t1').cwd));
    await mkdir(cDir, { recursive: true });
    await writeFile(join(cDir, `${SID0}.jsonl`), `${JSON.stringify({ type: 'user', text: 'earlier', writer: 'C' })}\n`);

    const res = await h.manager.send('t1', 'hello');
    expect(res).toEqual({ accepted: true });
    await h.manager.whenSettled('t1');

    const [a, b] = h.fake.calls;
    expect(h.fake.calls).toHaveLength(2);
    expect(a!.configDir).toBe(h.accounts[1]!.configDir);
    expect(b!.configDir).toBe(h.accounts[2]!.configDir);
    expect(b!.options.env?.CLAUDE_CONFIG_DIR).toBe(h.accounts[2]!.configDir);
    expect(a!.resume).toBe(SID0);
    expect(b!.resume).toBe(SID0);
    expect(b!.resumeMissing).toBe(false);
    expect(a!.prompts).toEqual(['hello']);
    expect(b!.prompts).toEqual(['hello']);

    // Both syncs use C (the last account with output) as the source; A produced no output.
    expect(h.syncs.map((s) => [s.from, s.to])).toEqual([
      [h.accounts[0]!.configDir, h.accounts[1]!.configDir],
      [h.accounts[0]!.configDir, h.accounts[2]!.configDir],
    ]);
    expect(h.usage.reports[0]).toMatchObject({ accountId: 'A', info: { status: 'rejected' } });
    expect(notices(h)).toContain('계정 전환: A → B (5시간 한도 도달)');

    const t = h.thread('t1');
    expect(t.lastAccountId).toBe('B');
    expect(t.activeAccountId).toBe('B');
    expect(t.status).toBe('idle');
    expect(t.pendingPrompt).toBeNull();
    // The late `result` of the rejected turn did not end the retry turn early: exactly one ok turn-end.
    const ends = chatEvents(h).filter((e) => e.type === 'turn-end');
    expect(ends).toEqual([
      { type: 'turn-end', ok: false, reason: 'rate_limited' },
      { type: 'turn-end', ok: true },
    ]);
  });

  it('(a) lastAccountId is not moved to a rejected account that produced no output', async () => {
    const h = setup({
      accounts: ['A', 'B'],
      thread: { sdkSessionId: SID0, lastAccountId: 'A' },
      scenario: ({ callIndex }) => (callIndex === 0 ? [rejected()] : [{ type: 'rateLimit', info: { status: 'rejected' } }]),
    });
    const aDir = join(h.accounts[0]!.configDir, 'projects', encodeCwd(h.thread('t1').cwd));
    await mkdir(aDir, { recursive: true });
    await writeFile(join(aDir, `${SID0}.jsonl`), '{}\n');
    await h.manager.send('t1', 'hello');
    await h.manager.whenSettled('t1');
    const t = h.thread('t1');
    expect(t.lastAccountId).toBe('A');
    expect(t.status).toBe('waiting');
    expect(t.pendingPrompt).toEqual({ text: 'hello', kind: 'original' });
  });

  it('(b)(f) partial output then rejection -> lastAccountId=A, A transcript copied to B after A exits, CONTINUE_PROMPT', async () => {
    const h = setup({
      accounts: ['A', 'B'],
      scenario: ({ callIndex }) =>
        callIndex === 0
          ? [{ type: 'text', text: 'partial work', chunks: 2 }, rejected()]
          : [{ type: 'text', text: 'continued on B' }],
    });

    await h.manager.send('t1', 'do the task');
    await h.manager.whenSettled('t1');

    const [a, b] = h.fake.calls;
    const sid = a!.sessionId;
    expect(b!.resume).toBe(sid);
    expect(b!.resumeMissing).toBe(false);
    expect(b!.prompts).toEqual([CONTINUE_PROMPT]);
    expect(h.syncs).toEqual([
      { sessionId: sid, from: h.accounts[0]!.configDir, to: h.accounts[1]!.configDir, found: true },
    ]);

    // B's copy contains A's lines including A's exit flush (copy happened after the CLI exited).
    const lines = await readTranscript(h, 'B', sid);
    const fromA = lines.filter((l) => l.writer === h.accounts[0]!.configDir);
    expect(fromA.map((l) => l.type)).toEqual(['user', 'assistant', 'flush']);
    expect(lines.some((l) => l.writer === h.accounts[1]!.configDir && l.text === CONTINUE_PROMPT)).toBe(true);

    // (f) close -> consumer loop end -> sync -> open(B)
    const tl = h.fake.timeline;
    const idx = (s: string) => tl.indexOf(s);
    expect(idx('close:0')).toBeGreaterThanOrEqual(0);
    expect(idx('close:0')).toBeLessThan(idx('end:0'));
    expect(idx('end:0')).toBeLessThan(idx('sync:A->B'));
    expect(idx('sync:A->B')).toBeLessThan(idx('open:1'));

    const t = h.thread('t1');
    expect(t.lastAccountId).toBe('B');
    expect(t.sdkSessionId).toBe(sid);
  });

  it('(b) lastAccountId is persisted as soon as the first output arrives', async () => {
    const seen: (string | null)[] = [];
    const h = setup({
      accounts: ['A', 'B'],
      scenario: ({ callIndex }) =>
        callIndex === 0 ? [{ type: 'text', text: 'partial' }, { type: 'pause' }, rejected()] : [{ type: 'text', text: 'ok' }],
    });
    await h.manager.send('t1', 'go');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    seen.push(h.thread('t1').lastAccountId);
    h.fake.release();
    await h.manager.whenSettled('t1');
    expect(seen).toEqual(['A']);
  });

  it('(c) pinned account is preferred; exhausted pin falls back to priority', async () => {
    const h = setup({ accounts: ['A', 'B'], thread: { pinnedAccountId: 'B' } });
    await h.manager.send('t1', 'one');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls[0]!.configDir).toBe(h.accounts[1]!.configDir);

    h.usage.set('B', exhausted(Date.now() + HOUR));
    await h.manager.send('t1', 'two');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls[1]!.configDir).toBe(h.accounts[0]!.configDir);
    expect(h.fake.calls[1]!.resume).toBe(h.fake.calls[0]!.sessionId);
  });

  it('(e) A -> B -> A: A copy is overwritten by the newer B transcript', async () => {
    const h = setup({ accounts: ['A', 'B'], scenario: ({ prompt }) => [{ type: 'text', text: `re: ${prompt}` }] });
    await h.manager.send('t1', 'turn1');
    await h.manager.whenSettled('t1');
    const sid = h.fake.calls[0]!.sessionId;

    h.usage.set('A', exhausted(Date.now() + HOUR));
    await h.manager.send('t1', 'turn2');
    await h.manager.whenSettled('t1');
    expect(h.thread('t1').lastAccountId).toBe('B');

    h.usage.set('A', { fiveHour: { percent: 5, resetsAt: null }, fetchedAt: Date.now(), stale: false });
    h.usage.set('B', exhausted(Date.now() + HOUR));
    await h.manager.send('t1', 'turn3');
    await h.manager.whenSettled('t1');

    expect(h.syncs.map((s) => [s.from, s.to])).toEqual([
      [h.accounts[0]!.configDir, h.accounts[1]!.configDir],
      [h.accounts[1]!.configDir, h.accounts[0]!.configDir],
    ]);
    const aLines = await readTranscript(h, 'A', sid);
    const texts = aLines.filter((l) => l.type === 'user').map((l) => l.text);
    expect(texts).toEqual(['turn1', 'turn2', 'turn3']);
    // turn2 in A's copy was written by B (came from the overwrite).
    expect(aLines.find((l) => l.text === 'turn2')!.writer).toBe(h.accounts[1]!.configDir);
    expect(h.fake.calls.map((c) => c.resume)).toEqual([undefined, sid, sid]);
    expect(h.thread('t1').lastAccountId).toBe('A');
  });

  it('(g) permission flow through the runner: requestId key, allow-session forces session destination', async () => {
    const h = setup({
      accounts: ['A'],
      scenario: () => [
        {
          type: 'tool',
          name: 'Edit',
          input: { file_path: 'x.ts' },
          permission: true,
          suggestions: [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'userSettings' }],
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
        },
      ],
    });
    await h.manager.send('t1', 'edit it');
    for (let i = 0; i < 30 && h.broadcaster.of('permission:request').length === 0; i++) await Promise.resolve();
    const [req] = h.broadcaster.of('permission:request');
    expect(req).toMatchObject({ threadId: 't1', toolName: 'Edit', hasSessionSuggestion: true });
    expect(req!.requestId).toMatch(/^req_fake_/);
    expect(h.manager.broker.pending().map((p) => p.requestId)).toEqual([req!.requestId]);
    h.manager.respondPermission(req!.requestId, 'allow-session');
    await h.manager.whenSettled('t1');

    expect(h.manager.broker.pending()).toHaveLength(0);
    expect(h.fake.calls[0]!.permissionResults).toEqual([
      {
        behavior: 'allow',
        updatedInput: { file_path: 'x.ts' },
        updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }],
      },
    ]);
    const tool = chatEvents(h)
      .filter((e): e is Extract<ChatEvent, { type: 'item-upsert' }> => e.type === 'item-upsert')
      .map((e) => e.item)
      .filter((i): i is Extract<ChatItem, { type: 'tool' }> => i.type === 'tool')
      .at(-1)!;
    expect(tool.isError).toBe(false);
    expect(tool.patch).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]);
  });

  it('(g) closing the thread denies pending permission requests', async () => {
    const h = setup({ accounts: ['A'], scenario: () => [{ type: 'tool', name: 'Bash', input: { command: 'ls' }, permission: true }] });
    await h.manager.send('t1', 'run');
    for (let i = 0; i < 30 && h.broadcaster.of('permission:request').length === 0; i++) await Promise.resolve();
    const [req] = h.broadcaster.of('permission:request');
    await h.manager.closeThread('t1');
    expect(h.broadcaster.of('permission:cancel')).toContainEqual({ requestId: req!.requestId });
    expect(h.manager.broker.pending()).toHaveLength(0);
    // The retired runner never opens another Query.
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(1);
  });

  it('(h) overage detected -> current turn completes on A, next turn uses another account', async () => {
    const h = setup({
      accounts: ['A', 'B'],
      scenario: ({ callIndex }) =>
        callIndex === 0
          ? [
              { type: 'rateLimit', info: { status: 'allowed', rateLimitType: 'overage', isUsingOverage: true } },
              { type: 'text', text: 'billed answer' },
            ]
          : [{ type: 'text', text: 'answer from B' }],
    });
    await h.manager.send('t1', 'first');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(1);
    expect(h.thread('t1').status).toBe('idle');
    expect(h.usage.usageById.A!.rejectedUntil?.overage).toBeGreaterThan(Date.now());

    await h.manager.send('t1', 'second');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(2);
    expect(h.fake.calls[1]!.configDir).toBe(h.accounts[1]!.configDir);
    expect(h.fake.calls[1]!.prompts).toEqual(['second']);
  });

  it('(i) ctxPercent comes from getContextUsage after result; init fills sid/model', async () => {
    const h = setup({ accounts: ['A'] });
    await h.manager.send('t1', 'hi');
    await h.manager.whenSettled('t1');
    const t = h.thread('t1');
    expect(t.ctxPercent).toBe(37);
    expect(t.sdkSessionId).toBe(h.fake.calls[0]!.sessionId);
    expect(t.resolvedModel).toBe('claude-fable-5');
    expect(t.sessionStartedAt).not.toBeNull();

    h.fake.setContextPercentage(64);
    await h.manager.send('t1', 'again');
    await h.manager.whenSettled('t1');
    expect(h.thread('t1').ctxPercent).toBe(64);
    // Same account -> same Query reused for the second turn.
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]!.prompts).toEqual(['hi', 'again']);
  });

  it('Query options: env via childEnv, bypass allowed, default mode, cleanupPeriodDays, binary path', async () => {
    const h = setup({ accounts: ['A'], thread: { model: 'sonnet' } });
    h.store.update((d) => {
      d.projects.push({ id: 'project-1', name: 'p', path: '/p', trusted: true, createdAt: 0 });
    });
    await h.manager.send('t1', 'hi');
    await h.manager.whenSettled('t1');
    const o = h.fake.calls[0]!.options;
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.permissionMode).toBe('default');
    expect(o.settings).toEqual({ cleanupPeriodDays: 3650 });
    expect(o.pathToClaudeCodeExecutable).toBe('/fixture/bin/claude');
    expect(o.includePartialMessages).toBe(true);
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.model).toBe('sonnet');
    expect(o.cwd).toBe(h.thread('t1').cwd);
    expect(o.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/fixture',
      CLAUDE_CONFIG_DIR: h.accounts[0]!.configDir,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'hopecode/0.1.0',
    });
  });

  it('setPermissionMode / setModel go to the live Query, otherwise to the next Query options', async () => {
    const h = setup({ accounts: ['A'] });
    await h.manager.setPermissionMode('t1', 'plan');
    await h.manager.send('t1', 'hi');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls[0]!.options.permissionMode).toBe('plan');

    await h.manager.setPermissionMode('t1', 'bypassPermissions');
    await h.manager.setModel('t1', 'fable');
    expect(h.fake.calls[0]!.permissionModes).toEqual(['bypassPermissions']);
    expect(h.fake.calls[0]!.models).toEqual(['fable']);
    expect(h.thread('t1').permissionMode).toBe('bypassPermissions');
    expect(h.thread('t1').model).toBe('fable');
    const all = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(await h.manager.listModels()).toEqual([
      { value: 'default', label: 'Default', description: 'Recommended model', effortLevels: all },
      { value: 'fable', label: 'Fable', description: 'Most capable', effortLevels: all },
      { value: 'sonnet', label: 'Sonnet', description: 'Fast everyday model', effortLevels: ['low', 'medium', 'high'] },
    ]);
  });

  it('effort: next Query options when idle, applyFlagSettings on the live Query, null back to default', async () => {
    const h = setup({ accounts: ['A'] });
    await h.manager.setEffort('t1', 'xhigh');
    expect(h.thread('t1').effort).toBe('xhigh');
    await h.manager.send('t1', 'hi');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls[0]!.options.effort).toBe('xhigh');

    await h.manager.setEffort('t1', 'low');
    await h.manager.setEffort('t1', null);
    expect(h.fake.calls[0]!.efforts).toEqual(['low', null]);
    expect(h.thread('t1').effort).toBeNull();

    // A new Query after the effort was cleared carries no effort option at all.
    const h2 = setup({ accounts: ['A'] });
    await h2.manager.send('t1', 'hi');
    await h2.manager.whenSettled('t1');
    expect('effort' in h2.fake.calls[0]!.options).toBe(false);
  });

  it('busy while running; user interrupt ends the turn as interrupted', async () => {
    const h = setup({ accounts: ['A'], scenario: () => [{ type: 'text', text: 'working' }, { type: 'pause' }] });
    await h.manager.send('t1', 'long task');
    expect(await h.manager.send('t1', 'another')).toEqual({ accepted: false, reason: 'busy' });
    await h.manager.interrupt('t1');
    await h.manager.whenSettled('t1');
    expect(h.thread('t1').status).toBe('idle');
    expect(chatEvents(h).filter((e) => e.type === 'turn-end').at(-1)).toEqual({
      type: 'turn-end',
      ok: false,
      reason: 'interrupted',
    });
  });

  it('no enabled account -> no-accounts', async () => {
    const h = setup({ accounts: ['A'] });
    h.accounts[0]!.enabled = false;
    expect(await h.manager.send('t1', 'hi')).toEqual({ accepted: false, reason: 'no-accounts' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('missing source transcript -> new session without resume + notice', async () => {
    const h = setup({ accounts: ['A', 'B'], thread: { sdkSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', lastAccountId: 'B' } });
    h.usage.set('B', exhausted(Date.now() + HOUR));
    await h.manager.send('t1', 'hi');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls[0]!.resume).toBeUndefined();
    expect(notices(h).some((n) => n.includes('찾지 못해'))).toBe(true);
    expect(h.thread('t1').sdkSessionId).toBe(h.fake.calls[0]!.sessionId);
  });

  it('(k) idle 10 minutes -> Query closed; next send resumes the session', async () => {
    vi.useFakeTimers();
    const h = setup({ accounts: ['A'], settings: { idleCloseMinutes: 10 } });
    await h.manager.send('t1', 'hi');
    await h.manager.whenSettled('t1');
    const sid = h.fake.calls[0]!.sessionId;

    await vi.advanceTimersByTimeAsync(9 * MINUTE_MS);
    expect(h.fake.calls[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1 * MINUTE_MS);
    await h.manager.whenSettled('t1');
    expect(h.fake.calls[0]!.closed).toBe(true);
    expect(h.fake.calls[0]!.ended).toBe(true);

    await h.manager.send('t1', 'back again');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(2);
    expect(h.fake.calls[1]!.resume).toBe(sid);
    expect(h.fake.calls[1]!.resumeMissing).toBe(false);
    expect(h.fake.calls[1]!.prompts).toEqual(['back again']);
    // Same account: no transcript copy needed.
    expect(h.syncs).toHaveLength(0);
  });

  it('(k) a send before the idle deadline keeps the Query open', async () => {
    vi.useFakeTimers();
    const h = setup({ accounts: ['A'], settings: { idleCloseMinutes: 10 } });
    await h.manager.send('t1', 'one');
    await h.manager.whenSettled('t1');
    await vi.advanceTimersByTimeAsync(8 * MINUTE_MS);
    await h.manager.send('t1', 'two');
    await h.manager.whenSettled('t1');
    await vi.advanceTimersByTimeAsync(8 * MINUTE_MS);
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]!.closed).toBe(false);
  });

  it('item ids stay unique across Queries of the same thread', async () => {
    const h = setup({ accounts: ['A', 'B'] });
    await h.manager.send('t1', 'one');
    await h.manager.whenSettled('t1');
    h.usage.set('A', exhausted(Date.now() + HOUR));
    await h.manager.send('t1', 'two');
    await h.manager.whenSettled('t1');
    const items = h.threadLog.items.get('t1')!;
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(items.filter((i) => i.type === 'assistant-text')).toHaveLength(2);
    expect(items.filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)).toEqual(['one', 'two']);
    expect(await readdir(join(h.accounts[1]!.configDir, 'projects'))).toHaveLength(1);
  });
});
