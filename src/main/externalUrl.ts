// Single gate for opening URLs in the user's browser (L1): https only; automatic opens (login flow)
// are further restricted to a host allowlist.
import { shell } from 'electron';

function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  return allowHosts.some((entry) =>
    entry.startsWith('*.') ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry,
  );
}

/** https URL (no credentials) and, when `allowHosts` is given, a host from that list. */
export function isSafeExternalUrl(url: string, allowHosts?: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (allowHosts && !hostAllowed(parsed.hostname.toLowerCase(), allowHosts)) return false;
  return true;
}

/** Opens `url` externally when it passes isSafeExternalUrl; returns whether it was opened. */
export function openExternalSafe(url: string, opts: { allowHosts?: readonly string[] } = {}): boolean {
  if (!isSafeExternalUrl(url, opts.allowHosts)) {
    console.warn(`[hopecode] refused to open external URL: ${url}`);
    return false;
  }
  shell.openExternal(url).catch((err: unknown) => console.error('[hopecode] openExternal failed', err));
  return true;
}
