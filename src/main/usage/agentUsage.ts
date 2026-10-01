// Account usage of non-Claude agents (plan 2.8). Only Hermes has a source: `hermes usage --json` (Hermes' default
// provider, no `--provider`). Codex shows no limits in v1 (Hermes' credential pool may be a different account than
// ~/.codex). Claude usage stays with the pool poller. A failure (exit != 0, timeout, bad JSON) = unavailable (null).
// stdout is parsed only, never logged.
import { execFile } from 'node:child_process';
import { parseHermesUsage } from '../../core/hermesUsageParse';
import { AGENTS } from '../../shared/agents';
import { MINUTE_MS } from '../../shared/constants';
import type { AgentKind, AgentUsageSnapshot } from '../../shared/types';
import type { AgentUsageService, Broadcaster, Unsubscribe } from '../contracts';

export const HERMES_USAGE_TIMEOUT_MS = 30_000;
/** Poll period while a thread of the agent is selected. */
export const AGENT_USAGE_POLL_MS = 5 * MINUTE_MS;
/** Minimum gap between two runs (turn-end refreshes are throttled to this). */
export const AGENT_USAGE_MIN_INTERVAL_MS = MINUTE_MS;
/** Failure backoff cap (the gap doubles per consecutive failure). */
export const AGENT_USAGE_MAX_BACKOFF_MS = 30 * MINUTE_MS;
const MAX_STDOUT_BYTES = 1024 * 1024;

/** Runs `hermes <args>`; resolves with the exit code (null = killed / timeout). */
export type HermesExec = (args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;

/** Seam implementation: `command` = resolved hermes path, `env` = the plan 2.10 Hermes env (never logged). */
export function createHermesExec(command: string, env: Record<string, string>): HermesExec {
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(command, args, { env, timeout: timeoutMs, maxBuffer: MAX_STDOUT_BYTES, encoding: 'utf8' }, (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout });
        const code = (err as { code?: unknown }).code;
        resolve({ code: typeof code === 'number' ? code : null, stdout: '' });
      });
    });
}

export interface AgentUsageDeps {
  /** null = Hermes not installed / not resolvable: nothing is spawned and the snapshot stays null. */
  hermes: () => HermesExec | null;
  broadcaster?: Broadcaster;
  now?: () => number;
  log?: (message: string) => void;
}

export interface AgentUsageServiceImpl extends AgentUsageService {
  /** Agent of the selected thread (null = none): it is polled every AGENT_USAGE_POLL_MS while selected. */
  setActive(agent: AgentKind | null): void;
  dispose(): void;
}

interface AgentState {
  snapshot: AgentUsageSnapshot | null;
  inflight: Promise<AgentUsageSnapshot | null> | null;
  /** No run before this time (min interval after success, doubling backoff after failures). */
  notBefore: number;
  failures: number;
}

export function createAgentUsageService(deps: AgentUsageDeps): AgentUsageServiceImpl {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const states = new Map<AgentKind, AgentState>();
  const listeners = new Set<(agent: AgentKind, snapshot: AgentUsageSnapshot | null) => void>();
  let active: AgentKind | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const hasSource = (agent: AgentKind): boolean => AGENTS[agent].usageSource === 'hermes';

  function state(agent: AgentKind): AgentState {
    let s = states.get(agent);
    if (!s) {
      s = { snapshot: null, inflight: null, notBefore: 0, failures: 0 };
      states.set(agent, s);
    }
    return s;
  }

  function publish(agent: AgentKind, s: AgentState, next: AgentUsageSnapshot | null): void {
    const changed = JSON.stringify(s.snapshot) !== JSON.stringify(next);
    s.snapshot = next;
    if (!changed) return;
    deps.broadcaster?.emit('agentUsage:updated', { agent, snapshot: next });
    for (const cb of listeners) cb(agent, next);
  }

  async function fetchOnce(agent: AgentKind): Promise<AgentUsageSnapshot | null> {
    const exec = deps.hermes();
    if (!exec) return null;
    try {
      const { code, stdout } = await exec(['usage', '--json'], HERMES_USAGE_TIMEOUT_MS);
      if (code !== 0) {
        log(`[agentUsage] hermes usage unavailable (exit ${code ?? 'timeout'})`);
        return null;
      }
      return parseHermesUsage(stdout, agent, now());
    } catch {
      log('[agentUsage] hermes usage failed to run');
      return null;
    }
  }

  function refresh(agent: AgentKind): Promise<AgentUsageSnapshot | null> {
    if (!hasSource(agent)) return Promise.resolve(null);
    const s = state(agent);
    if (s.inflight) return s.inflight;
    if (now() < s.notBefore) return Promise.resolve(s.snapshot);
    s.inflight = fetchOnce(agent).then((next) => {
      s.inflight = null;
      s.failures = next ? 0 : s.failures + 1;
      const gap = next
        ? AGENT_USAGE_MIN_INTERVAL_MS
        : Math.min(AGENT_USAGE_POLL_MS * 2 ** (s.failures - 1), AGENT_USAGE_MAX_BACKOFF_MS);
      s.notBefore = now() + gap;
      publish(agent, s, next);
      return next;
    });
    return s.inflight;
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(agent: AgentKind): void {
    clearTimer();
    if (active !== agent) return;
    const s = state(agent);
    const delay = Math.max(AGENT_USAGE_POLL_MS, s.notBefore - now());
    timer = setTimeout(() => {
      timer = null;
      void refresh(agent).finally(() => schedule(agent));
    }, delay);
  }

  return {
    get: (agent) => states.get(agent)?.snapshot ?? null,
    refresh,
    onUpdate(cb): Unsubscribe {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setActive(agent) {
      if (agent === active) return;
      active = agent;
      clearTimer();
      if (!agent || !hasSource(agent)) return;
      void refresh(agent).finally(() => schedule(agent));
    },
    dispose() {
      active = null;
      clearTimer();
    },
  };
}
