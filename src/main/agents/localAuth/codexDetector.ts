// Codex local login: reads `$CODEX_HOME/auth.json` (default `~/.codex`) read-only (plan 2.9.2 / 2.9.4).
// Only `email`, the plan and a coarse method leave this function; token strings are never copied anywhere.
import { join } from 'node:path';
import type { DecodeJwtClaimsFn } from '../../../core/acpTypes';
import type { LocalAuthInfo } from '../../../shared/types';
import { baseInfo, type DetectorDeps } from './detectorDeps';

const MAX_AUTH_BYTES = 1024 * 1024;

export interface CodexDetectorDeps extends DetectorDeps {
  /** `agentBinaries.resolveCodexAcp` (null = not installed). */
  codexPath: () => string | null;
  /** Login-shell env (CODEX_HOME, OPENAI_API_KEY, CODEX_API_KEY). */
  env: () => Record<string, string>;
  /** core/jwtClaims `decodeJwtClaims` (Lane A). Payload only, never throws. */
  decodeJwtClaims: DecodeJwtClaimsFn;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export async function detectCodex(deps: CodexDetectorDeps): Promise<LocalAuthInfo> {
  const env = deps.env();
  const home = nonEmpty(env['CODEX_HOME']) ? env['CODEX_HOME'] : join(deps.homedir(), '.codex');
  const info = baseInfo('codex', join(home, 'auth.json'), deps.now());
  if (!deps.codexPath()) return { ...info, state: 'not-installed', detail: 'codex-acp-not-found' };

  const envKey = nonEmpty(env['OPENAI_API_KEY']) || nonEmpty(env['CODEX_API_KEY']);
  let raw: string | null = null;
  try {
    raw = await deps.readFile(join(home, 'auth.json'), MAX_AUTH_BYTES);
  } catch {
    raw = null;
  }

  if (raw === null) {
    if (envKey) return { ...info, state: 'logged-in', method: 'api-key', plan: 'API key', source: 'env' };
    try {
      const toml = await deps.readFile(join(home, 'config.toml'), MAX_AUTH_BYTES);
      const m = /^\s*cli_auth_credentials_store\s*=\s*["']([^"']*)["']/m.exec(toml);
      if (m && m[1] !== 'file') return { ...info, state: 'logged-out', detail: 'keyring-store' };
    } catch {
      // no config.toml
    }
    return { ...info, state: 'logged-out', detail: 'auth-file-missing' };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...info, state: 'error', detail: 'auth-file-unreadable' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ...info, state: 'error', detail: 'auth-file-unreadable' };
  }
  const auth = json as Record<string, unknown>;
  const tokens = typeof auth['tokens'] === 'object' && auth['tokens'] !== null ? (auth['tokens'] as Record<string, unknown>) : {};
  const idToken = tokens['id_token'];
  const mode = typeof auth['auth_mode'] === 'string' ? auth['auth_mode'].toLowerCase().replace(/[^a-z]/g, '') : '';

  if (mode !== 'apikey' && nonEmpty(idToken)) {
    const claims = deps.decodeJwtClaims(idToken);
    const out: LocalAuthInfo = { ...info, state: 'logged-in', method: 'chatgpt' };
    if (!claims) return { ...out, detail: 'id-token-unreadable' };
    out.email = claims.email;
    out.plan = claims.plan;
    if (claims.exp !== null && claims.exp * 1000 < deps.now()) out.detail = 'id-token-expired';
    return out;
  }
  if (mode === 'apikey' || nonEmpty(auth['OPENAI_API_KEY']) || envKey) {
    return { ...info, state: 'logged-in', method: 'api-key', plan: 'API key' };
  }
  return { ...info, state: 'logged-out', detail: 'no-credentials' };
}
