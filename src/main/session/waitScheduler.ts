// Waiting-thread scheduler (plan 4.2 session/waitScheduler.ts, R16).
// A 60s setInterval compares Date.now() with thread.waitingUntil (long setTimeouts drift across sleep);
// reevaluate() runs the same check immediately (powerMonitor resume, usage:updated).
import { WAIT_TICK_MS } from '../../shared/constants';

export interface WaitSchedulerDeps {
  /** Current waitingUntil of a tracked thread (null / undefined -> no longer waiting, dropped). */
  getWaitingUntil: (threadId: string) => number | null | undefined;
  /**
   * Try to resume the thread. `due` = waitingUntil has passed (caller refreshes usage first);
   * when not due the caller only resumes if an account is already available.
   */
  evaluate: (threadId: string, due: boolean) => Promise<void>;
  now?: () => number;
  tickMs?: number;
  log?: (message: string, err?: unknown) => void;
}

export interface WaitScheduler {
  track(threadId: string): void;
  untrack(threadId: string): void;
  tracked(): string[];
  /** Evaluate every tracked thread now. */
  reevaluate(): Promise<void>;
  stop(): void;
}

export function createWaitScheduler(deps: WaitSchedulerDeps): WaitScheduler {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? WAIT_TICK_MS;
  const threads = new Set<string>();
  const inflight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function syncTimer(): void {
    if (threads.size > 0 && !timer) {
      timer = setInterval(() => void run(false), tickMs);
    } else if (threads.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function run(includeNotDue: boolean): Promise<void> {
    const t = now();
    const jobs: Promise<void>[] = [];
    for (const threadId of [...threads]) {
      const until = deps.getWaitingUntil(threadId);
      if (until == null) {
        threads.delete(threadId);
        continue;
      }
      const due = t >= until;
      if ((!due && !includeNotDue) || inflight.has(threadId)) continue;
      inflight.add(threadId);
      jobs.push(
        deps
          .evaluate(threadId, due)
          .catch((err: unknown) => deps.log?.(`[waitScheduler] evaluate failed for ${threadId}`, err))
          .finally(() => {
            inflight.delete(threadId);
            if (deps.getWaitingUntil(threadId) == null) threads.delete(threadId);
            syncTimer();
          }),
      );
    }
    syncTimer();
    await Promise.all(jobs);
  }

  return {
    track(threadId) {
      threads.add(threadId);
      syncTimer();
    },
    untrack(threadId) {
      threads.delete(threadId);
      syncTimer();
    },
    tracked() {
      return [...threads];
    },
    reevaluate() {
      return run(true);
    },
    stop() {
      threads.clear();
      syncTimer();
    },
  };
}
