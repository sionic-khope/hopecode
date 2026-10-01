// Display claims of a Codex id_token (payload only, signature not verified). Pure; never throws.
import type { DecodeJwtClaimsFn } from './acpTypes';

const AUTH_CLAIM = 'https://api.openai.com/auth';

function base64UrlDecode(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(segment)) return null;
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export const decodeJwtClaims: DecodeJwtClaimsFn = (jwt) => {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.trim().split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const json = base64UrlDecode(parts[1]);
  if (json === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const auth = p[AUTH_CLAIM];
  const plan = auth && typeof auth === 'object' ? (auth as Record<string, unknown>).chatgpt_plan_type : null;
  return {
    email: typeof p.email === 'string' ? p.email : null,
    plan: typeof plan === 'string' ? plan : null,
    exp: typeof p.exp === 'number' && Number.isFinite(p.exp) ? p.exp : null,
  };
};
