// Cached, deduped local-auth detection for all agents (plan 2.9.3). Results carry no secrets by type.
import type { AgentKind, AgentAvailability, LocalAuthInfo } from '../../../shared/types';
import type { LocalAuthService, Unsubscribe } from '../../contracts';

export const LOCAL_AUTH_TTL_MS = 5 * 60 * 1000;
/** A forced recheck (재확인, spawns processes) runs at most once per agent in this window; others get the cache. */
export const LOCAL_AUTH_FORCE_MIN_INTERVAL_MS = 10_000;

export interface LocalAuthDetectors {
  'claude-code': () => Promise<LocalAuthInfo>;
  codex: () => Promise<LocalAuthInfo>;
  /** `probe` = run the (process-spawning) initialize probe. */
  hermes: (opts: { probe: boolean; prev: LocalAuthInfo | null }) => Promise<LocalAuthInfo>;
}

export interface LocalAuthServiceDeps {
  detectors: LocalAuthDetectors;
  now?: () => number;
  ttlMs?: number;
  forceMinIntervalMs?: number;
}

const AGENTS: AgentKind[] = ['claude-code', 'codex', 'hermes'];

const signature = (list: LocalAuthInfo[]): string => JSON.stringify(list.map((i) => ({ ...i, checkedAt: 0 })));

export function createLocalAuthService(deps: LocalAuthServiceDeps): LocalAuthService {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? LOCAL_AUTH_TTL_MS;
  const forceInterval = deps.forceMinIntervalMs ?? LOCAL_AUTH_FORCE_MIN_INTERVAL_MS;
  const lastForcedAt = new Map<AgentKind, number>();
  const cache = new Map<AgentKind, LocalAuthInfo>();
  const inflight = new Map<AgentKind, Promise<LocalAuthInfo>>();
  const listeners = new Set<(list: LocalAuthInfo[]) => void>();
  let lastSig = signature([]);

  const list = (): LocalAuthInfo[] => AGENTS.flatMap((a) => (cache.has(a) ? [cache.get(a) as LocalAuthInfo] : []));

  function detect(agent: AgentKind, force: boolean): Promise<LocalAuthInfo> {
    const existing = inflight.get(agent);
    if (existing) return existing;
    const prev = cache.get(agent) ?? null;
    const run = (): Promise<LocalAuthInfo> => {
      if (agent === 'hermes') return deps.detectors.hermes({ probe: force || prev === null, prev });
      return deps.detectors[agent]();
    };
    const p = run()
      .catch(
        (): LocalAuthInfo => ({
          agent,
          state: 'error',
          method: null,
          email: null,
          plan: null,
          provider: null,
          source: '',
          version: null,
          detail: 'detect-failed',
          checkedAt: now(),
        }),
      )
      .then((info) => {
        cache.set(agent, info);
        return info;
      })
      .finally(() => inflight.delete(agent));
    inflight.set(agent, p);
    return p;
  }

  return {
    list,
    async recheck(agent, opts) {
      const force = opts?.force === true;
      const targets = agent ? [agent] : AGENTS;
      await Promise.all(
        targets.map((a) => {
          const cached = cache.get(a);
          const last = lastForcedAt.get(a);
          const forced = force && (last === undefined || now() - last >= forceInterval);
          if (forced) lastForcedAt.set(a, now());
          // A throttled force falls back to the cache (or a normal, non-probing detection without one).
          if (!forced && cached && (force || now() - cached.checkedAt < ttl)) return Promise.resolve(cached);
          return detect(a, forced);
        }),
      );
      const result = list();
      const sig = signature(result);
      if (sig !== lastSig) {
        lastSig = sig;
        for (const cb of [...listeners]) cb(result);
      }
      return result;
    },
    availability(agent): AgentAvailability {
      const info = cache.get(agent);
      if (!info) return { agent, usable: false, reason: 'error' };
      if (info.state === 'logged-in') return { agent, usable: true, reason: 'ok' };
      if (info.state === 'not-installed') return { agent, usable: false, reason: 'not-installed' };
      if (info.state === 'logged-out') return { agent, usable: false, reason: 'not-logged-in' };
      return { agent, usable: false, reason: 'error' };
    },
    onChange(cb): Unsubscribe {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
