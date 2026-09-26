import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScheduler, type SchedulerDeps } from '../../src/main/schedule/scheduler';
import type { Schedule, ScheduleInput } from '../../src/shared/nav';
import type { Thread, ThreadStartRequest, ThreadStartResult } from '../../src/shared/types';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('scheduler', () => {
  let dir: string;
  let now: number;
  let started: ThreadStartRequest[];
  let changes: Schedule[][];
  let result: ThreadStartResult;

  const input = (patch: Partial<ScheduleInput> = {}): ScheduleInput => ({
    projectId: 'p1',
    prompt: '밤사이 실패한 테스트 확인',
    model: 'default',
    permissionMode: 'plan',
    effort: null,
    repeat: { kind: 'daily', time: '09:00' },
    enabled: true,
    ...patch,
  });

  const make = (patch: Partial<SchedulerDeps> = {}) =>
    createScheduler({
      filePath: join(dir, 'schedules.json'),
      now: () => now,
      projectIds: () => new Set(['p1']),
      startThread: async (req) => {
        started.push(req);
        return result;
      },
      onChange: (list) => changes.push(list),
      ...patch,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hopecode-sched-'));
    now = local(2026, 9, 26, 8, 0);
    started = [];
    changes = [];
    result = { ok: true, thread: { id: 'thread-1' } as Thread, send: { accepted: true } };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates with the next occurrence, runs it through thread:start at the time, and records the thread', async () => {
    const s = make();
    await s.load();
    const saved = await s.save(input());
    expect(saved.nextRunAt).toBe(local(2026, 9, 26, 9, 0));

    now = local(2026, 9, 26, 8, 59);
    await s.tick();
    expect(started).toHaveLength(0);

    now = local(2026, 9, 26, 9, 0) + 5_000;
    await s.tick();
    expect(started).toEqual([{ projectId: 'p1', text: '밤사이 실패한 테스트 확인', model: 'default', permissionMode: 'plan', effort: null }]);
    const [after] = s.list();
    expect(after!.runs[0]).toMatchObject({ status: 'started', threadId: 'thread-1', scheduledAt: local(2026, 9, 26, 9, 0) });
    expect(after!.nextRunAt).toBe(local(2026, 9, 27, 9, 0));
    // A second tick in the same minute does not run it again.
    await s.tick();
    expect(started).toHaveLength(1);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('waiting (pool exhausted) and refused starts are recorded as such', async () => {
    const s = make();
    await s.load();
    await s.save(input());
    result = { ok: true, thread: { id: 'thread-2' } as Thread, send: { accepted: true, reason: 'waiting' } };
    now = local(2026, 9, 26, 9, 1);
    await s.tick();
    expect(s.list()[0]!.runs[0]).toMatchObject({ status: 'waiting', threadId: 'thread-2' });

    result = { ok: false, reason: 'no-accounts' };
    now = local(2026, 9, 27, 9, 1);
    await s.tick();
    expect(s.list()[0]!.runs[0]).toMatchObject({ status: 'failed', threadId: null, error: '사용할 수 있는 계정이 없습니다' });
  });

  it('occurrences that passed while the app was closed are missed on load, never run', async () => {
    const first = make();
    await first.load();
    await first.save(input());
    await first.flush();

    now = local(2026, 9, 28, 12, 0);
    const reopened = make();
    await reopened.load();
    expect(started).toHaveLength(0);
    const [s] = reopened.list();
    expect(s!.runs).toEqual([
      { scheduledAt: local(2026, 9, 28, 9, 0), at: now, status: 'missed', threadId: null, missedCount: 3 },
    ]);
    expect(s!.nextRunAt).toBe(local(2026, 9, 29, 9, 0));
  });

  it('a one-off runs once and turns itself off', async () => {
    const s = make();
    await s.load();
    const at = local(2026, 9, 26, 10, 30);
    await s.save(input({ repeat: { kind: 'once', at } }));
    now = at + 1000;
    await s.tick();
    now = at + 86_400_000;
    await s.tick();
    expect(started).toHaveLength(1);
    expect(s.list()[0]).toMatchObject({ enabled: false, nextRunAt: null });
    await expect(s.setEnabled(s.list()[0]!.id, true)).rejects.toThrow(/지난 1회 예약/);
  });

  it('refuses bypassPermissions and unknown projects (main-side validation)', async () => {
    const s = make();
    await s.load();
    await expect(s.save({ ...input(), permissionMode: 'bypassPermissions' })).rejects.toThrow(/전체 액세스/);
    await expect(s.save(input({ projectId: 'other' }))).rejects.toThrow(/등록된 프로젝트/);
    expect(s.list()).toEqual([]);
  });

  it('a schedule whose project was removed fails instead of running', async () => {
    const s = make({ projectIds: () => new Set(['p1']) });
    await s.load();
    await s.save(input());
    const gone = make({ projectIds: () => new Set<string>() });
    await s.flush();
    await gone.load();
    now = local(2026, 9, 26, 9, 0);
    await gone.tick();
    expect(started).toHaveLength(0);
    expect(gone.list()[0]!.runs[0]).toMatchObject({ status: 'failed' });
  });

  it('toggle, edit and delete persist to schedules.json', async () => {
    const s = make();
    await s.load();
    const saved = await s.save(input());
    await s.setEnabled(saved.id, false);
    expect(s.list()[0]).toMatchObject({ enabled: false, nextRunAt: null });
    await s.save({ ...input(), repeat: { kind: 'weekly', weekday: 1, time: '10:00' } }, saved.id);
    await s.flush();
    const onDisk = JSON.parse(readFileSync(join(dir, 'schedules.json'), 'utf8')) as { schedules: Schedule[] };
    expect(onDisk.schedules[0]).toMatchObject({ id: saved.id, repeat: { kind: 'weekly', weekday: 1, time: '10:00' }, enabled: true });
    await s.remove(saved.id);
    await s.flush();
    expect(JSON.parse(readFileSync(join(dir, 'schedules.json'), 'utf8')).schedules).toEqual([]);
  });

  it('a corrupt file is backed up and the scheduler starts empty; stored bypass entries are dropped', async () => {
    writeFileSync(join(dir, 'schedules.json'), '{broken');
    const s = make();
    await s.load();
    expect(s.list()).toEqual([]);

    writeFileSync(
      join(dir, 'schedules.json'),
      JSON.stringify({ version: 1, schedules: [{ ...input(), permissionMode: 'bypassPermissions', id: 'x', runs: [], nextRunAt: null }] }),
    );
    const again = make();
    await again.load();
    expect(again.list()).toEqual([]);
  });
});
