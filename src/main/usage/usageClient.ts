// GET /api/oauth/usage (plan 0.2, ported from OMC hud/usage-api.js fetchUsageFromApi / buildUserAgent).
// No `/v1/messages` probe fallback: 403 is reported as `auth`.
import {
  CLI_VERSION_PATTERN,
  USAGE_BETA_HEADER,
  USAGE_ENDPOINT,
  USAGE_FETCH_TIMEOUT_MS,
} from '../../shared/constants';
import type { UsageClient, UsageFetchResult } from '../contracts';

/**
 * `claude-code/<version>`. The endpoint throttles requests without a versioned UA to ~1/hour, so the
 * version must be real (SDK init claude_code_version or manifest.json); invalid -> no header.
 */
export function buildUserAgent(cliVersion: string | null | undefined): string | undefined {
  if (typeof cliVersion !== 'string') return undefined;
  const v = cliVersion.trim();
  if (v.length > 128 || !CLI_VERSION_PATTERN.test(v)) return undefined;
  return `claude-code/${v}`;
}

/** `retry-after` seconds or HTTP date -> ms. */
function parseRetryAfter(h: string | null, now: number): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function createUsageClient(
  deps: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): UsageClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? USAGE_FETCH_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  return {
    async fetchUsage(accessToken, cliVersion): Promise<UsageFetchResult> {
      const ua = buildUserAgent(cliVersion);
      let res: Response;
      try {
        res = await doFetch(USAGE_ENDPOINT, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'anthropic-beta': USAGE_BETA_HEADER,
            'Content-Type': 'application/json',
            ...(ua ? { 'User-Agent': ua } : {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { status: 'network', message: (err as Error)?.message ?? String(err) };
      }
      if (res.status === 200) {
        try {
          return { status: 'ok', data: await res.json() };
        } catch {
          return { status: 'network', message: 'invalid JSON body' };
        }
      }
      if (res.status === 429) {
        return { status: 'rate_limited', retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), now()) };
      }
      if (res.status === 401 || res.status === 403) return { status: 'auth' };
      return { status: 'network', message: `HTTP ${res.status}` };
    },
  };
}
