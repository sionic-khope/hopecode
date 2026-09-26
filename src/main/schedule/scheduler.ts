// 예약 scheduler: persisted schedules (`schedules.json` in the data folder), a wall-clock check every `tickMs`
// (plus an explicit `tick()` on power resume), and the run itself through the same path as a draft's first send
// (`thread:start`: worktree, title, account selection, waiting for a reset). Occurrences found too late (app
// closed, machine asleep) are recorded as missed and never run on their own.
import { randomUUID } from 'node:crypto';
import { copyFile, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  SCHEDULE_GRACE_MS,
  SCHEDULE_RUNS_KEPT,
  evaluateSchedule,
  nextOccurrence,
  validateScheduleInput,
} from '../../core/schedule';
import type { Schedule, ScheduleRun } from '../../shared/nav';
import type { ThreadStartRequest, ThreadStartResult } from '../../shared/types';
import { PRIVATE_FILE_MODE, mkdirPrivate } from '../persistence/jsonl';

export const SCHEDULE_TICK_MS = 15_000;

export interface SchedulerDeps {
  filePath: string;
  now: () => number;
  projectIds: () => ReadonlySet<string>;
  /** `thread:start` (creates the thread, sends the prompt, broadcasts it). */
  startThread: (req: ThreadStartRequest) => Promise<ThreadStartResult>;
  onChange: (schedules: Schedule[]) => void;
  tickMs?: number;
  graceMs?: number;
}

export interface Scheduler {
  load(): Promise<void>;
  start(): void;
  stop(): void;
  list(): Schedule[];
  /** Creates (no `id`) or replaces a schedule; the input is validated here. Throws with a user-facing message. */
  save(raw: unknown, id?: string): Promise<Schedule>;
  setEnabled(id: string, enabled: boolean): Promise<Schedule>;
  remove(id: string): Promise<void>;
  /** Evaluates every schedule against the clock (interval, power resume, fixture clock). */
  tick(): Promise<void>;
  flush(): Promise<void>;
}

const REASON_TEXT: Record<string, string> = {
  busy: '스레드가 실행 중입니다',
  'no-accounts': '사용할 수 있는 계정이 없습니다',
  auth: '모든 계정에 다시 로그인해야 합니다',
};

function cloneAll(list: readonly Schedule[]): Schedule[] {
  return list.map((s) => ({ ...s, repeat: { ...s.repeat }, runs: s.runs.map((r) => ({ ...r })) }));
}

function sanitize(raw: unknown): Schedule[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { schedules?: unknown }).schedules)) return [];
  const out: Schedule[] = [];
  for (const entry of (raw as { schedules: unknown[] }).schedules) {
    if (typeof entry !== 'object' || entry === null) continue;
    const s = entry as Partial<Schedule>;
    if (typeof s.id !== 'string') continue;
    // Stored entries pass the same checks as new ones (without the "not in the past" rule).
    const checked = validateScheduleInput(entry, { projectIds: new Set([String(s.projectId)]) });
    if (!checked.ok) continue;
    out.push({
      ...checked.input,
      id: s.id,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
      nextRunAt: typeof s.nextRunAt === 'number' ? s.nextRunAt : null,
      runs: Array.isArray(s.runs) ? s.runs.filter((r): r is ScheduleRun => typeof r === 'object' && r !== null).slice(0, SCHEDULE_RUNS_KEPT) : [],
    });
  }
  return out;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const graceMs = deps.graceMs ?? SCHEDULE_GRACE_MS;
  let schedules: Schedule[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking: Promise<void> | null = null;
  let writing: Promise<void> = Promise.resolve();
  /** False until load() read the file (or found none): an unreadable file is never overwritten. */
  let loaded = false;

  async function writeOnce(): Promise<void> {
    await mkdirPrivate(dirname(deps.filePath));
    const tmp = `${deps.filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const fh = await open(tmp, 'w', PRIVATE_FILE_MODE);
      try {
        await fh.writeFile(JSON.stringify({ version: 1, schedules }, null, 2), 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, deps.filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  function persist(): Promise<void> {
    const next = writing.then(writeOnce, writeOnce);
    writing = next.catch((err: unknown) => console.error('[scheduler] save failed', err));
    deps.onChange(cloneAll(schedules));
    return writing;
  }

  function assertLoaded(): void {
    if (!loaded) throw new Error('예약 파일을 읽지 못해 저장할 수 없습니다');
  }

  function find(id: string): Schedule {
    const s = schedules.find((x) => x.id === id);
    if (!s) throw new Error('예약을 찾을 수 없습니다');
    return s;
  }

  function pushRun(s: Schedule, run: ScheduleRun): void {
    s.runs = [run, ...s.runs].slice(0, SCHEDULE_RUNS_KEPT);
  }

  /** Applies the clock to every schedule; returns the occurrences to run now. */
  function judge(now: number): { schedule: Schedule; run: ScheduleRun }[] {
    const due: { schedule: Schedule; run: ScheduleRun }[] = [];
    let changed = false;
    for (const s of schedules) {
      const verdict = evaluateSchedule(s, now, graceMs);
      if (verdict.due === null && verdict.missed === null) continue;
      changed = true;
      if (verdict.missed) {
        pushRun(s, { scheduledAt: verdict.missed.latest, at: now, status: 'missed', threadId: null, missedCount: verdict.missed.count });
      }
      if (verdict.due !== null) {
        const run: ScheduleRun = { scheduledAt: verdict.due, at: now, status: 'started', threadId: null };
        pushRun(s, run);
        due.push({ schedule: s, run });
      }
      s.nextRunAt = verdict.nextRunAt;
      if (s.repeat.kind === 'once') {
        s.enabled = false;
        s.nextRunAt = null;
      }
    }
    if (changed) void persist();
    return due;
  }

  async function execute(schedule: Schedule, run: ScheduleRun): Promise<void> {
    const setRun = (patch: Partial<ScheduleRun>) => {
      Object.assign(run, patch);
      void persist();
    };
    if (!deps.projectIds().has(schedule.projectId)) {
      setRun({ status: 'failed', error: '프로젝트가 더 이상 등록되어 있지 않습니다' });
      return;
    }
    try {
      const result = await deps.startThread({
        projectId: schedule.projectId,
        text: schedule.prompt,
        model: schedule.model,
        permissionMode: schedule.permissionMode,
        effort: schedule.effort,
      });
      if (result.ok) setRun({ status: result.send.reason === 'waiting' ? 'waiting' : 'started', threadId: result.thread.id });
      else setRun({ status: 'failed', error: REASON_TEXT[result.reason] ?? result.reason });
    } catch (err) {
      setRun({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function tick(): Promise<void> {
    // One evaluation at a time; a tick that arrives mid-run waits and then re-checks the clock.
    while (ticking) await ticking;
    const current = (async () => {
      for (const { schedule, run } of judge(deps.now())) await execute(schedule, run);
    })();
    ticking = current;
    try {
      await current;
    } finally {
      ticking = null;
    }
  }

  return {
    async load() {
      let text: string | null = null;
      try {
        text = await readFile(deps.filePath, 'utf8');
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
      if (text !== null) {
        try {
          schedules = sanitize(JSON.parse(text));
        } catch {
          await copyFile(deps.filePath, `${deps.filePath}.corrupt-${Date.now()}`).catch(() => {});
          console.error('[scheduler] schedules.json could not be parsed; starting empty');
          schedules = [];
        }
      }
      loaded = true;
      // Launch: whatever came due while the app was closed is judged now (missed unless within the grace window).
      await tick();
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch((err: unknown) => console.error('[scheduler] tick failed', err)), deps.tickMs ?? SCHEDULE_TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    list: () => cloneAll(schedules),
    async save(raw, id) {
      assertLoaded();
      const now = deps.now();
      const checked = validateScheduleInput(raw, { projectIds: deps.projectIds(), now });
      if (!checked.ok) throw new Error(checked.error);
      const input = checked.input;
      const nextRunAt = input.enabled ? nextOccurrence(input.repeat, now) : null;
      let saved: Schedule;
      if (id !== undefined) {
        const existing = find(id);
        Object.assign(existing, input, { nextRunAt, updatedAt: now });
        saved = existing;
      } else {
        saved = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, nextRunAt, runs: [] };
        schedules.push(saved);
      }
      await persist();
      return cloneAll([saved])[0]!;
    },
    async setEnabled(id, enabled) {
      assertLoaded();
      const s = find(id);
      const now = deps.now();
      if (enabled) {
        const next = nextOccurrence(s.repeat, now);
        if (next === null) throw new Error('이미 지난 1회 예약입니다. 시각을 바꿔 다시 저장하세요');
        s.nextRunAt = next;
      } else {
        s.nextRunAt = null;
      }
      s.enabled = enabled;
      s.updatedAt = now;
      await persist();
      return cloneAll([s])[0]!;
    },
    async remove(id) {
      assertLoaded();
      const before = schedules.length;
      schedules = schedules.filter((s) => s.id !== id);
      if (schedules.length !== before) await persist();
    },
    tick,
    async flush() {
      await writing;
    },
  };
}
