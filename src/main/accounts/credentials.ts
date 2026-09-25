// Read-only OAuth credential lookup per account config dir (plan 0.2, ported from OMC hud/usage-api.js).
// Order: Keychain (`-a <user>` then no account) -> `<configDir>/.credentials.json`.
// No token refresh and no Keychain write-back: expired tokens surface as `token_expired`.
import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { keychainServiceName } from '../../core/keychainName';
import { KEYCHAIN_TIMEOUT_MS } from '../../shared/constants';
import type { Credentials, CredentialsResult } from '../contracts';

export const SECURITY_BIN = '/usr/bin/security';
/** Cache lifetime for tokens that carry no expiresAt. */
const NO_EXPIRY_CACHE_MS = 5 * 60_000;

export type ExecFileFn = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;

export interface CredentialsDeps {
  execFile?: ExecFileFn;
  readFile?: (path: string) => Promise<string>;
  /** OS username for `security -a`; undefined skips the account-scoped lookup. */
  username?: () => string | undefined;
  now?: () => number;
  platform?: NodeJS.Platform;
  serviceName?: (configDir: string) => string;
}

interface RawCreds {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

type OkResult = Extract<CredentialsResult, { status: 'ok' }>;

const defaultExecFile: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { timeout: opts.timeout, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });

function defaultUsername(): string | undefined {
  try {
    return userInfo().username?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** `claudeAiOauth ?? root` with a string accessToken, else null. */
export function parseCredentialJson(text: string): RawCreds | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const c = (typeof root.claudeAiOauth === 'object' && root.claudeAiOauth !== null
    ? root.claudeAiOauth
    : root) as Record<string, unknown>;
  if (typeof c.accessToken !== 'string' || c.accessToken === '') return null;
  return {
    accessToken: c.accessToken,
    expiresAt: typeof c.expiresAt === 'number' && Number.isFinite(c.expiresAt) ? c.expiresAt : null,
    subscriptionType: typeof c.subscriptionType === 'string' ? c.subscriptionType : null,
    rateLimitTier: typeof c.rateLimitTier === 'string' ? c.rateLimitTier : null,
  };
}

export function createCredentials(deps: CredentialsDeps = {}): Credentials {
  const execFile = deps.execFile ?? defaultExecFile;
  const readFile = deps.readFile ?? ((p: string) => nodeReadFile(p, 'utf8'));
  const username = deps.username ?? defaultUsername;
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const serviceName = deps.serviceName ?? ((dir: string) => keychainServiceName(dir, sha256Hex));
  const cache = new Map<string, { result: OkResult; until: number }>();

  const isExpired = (c: RawCreds): boolean => c.expiresAt != null && c.expiresAt <= now();

  async function readKeychain(configDir: string): Promise<RawCreds[]> {
    if (platform !== 'darwin') return [];
    const service = serviceName(configDir);
    const user = username();
    const attempts: string[][] = [];
    if (user) attempts.push(['find-generic-password', '-s', service, '-a', user, '-w']);
    attempts.push(['find-generic-password', '-s', service, '-w']);
    const found: RawCreds[] = [];
    for (const args of attempts) {
      try {
        const { stdout } = await execFile(SECURITY_BIN, args, { timeout: KEYCHAIN_TIMEOUT_MS });
        const creds = parseCredentialJson(stdout);
        if (!creds) continue;
        found.push(creds);
        if (!isExpired(creds)) break;
      } catch {
        // item missing / access denied / timeout -> try next
      }
    }
    return found;
  }

  async function readFileCreds(configDir: string): Promise<RawCreds | null> {
    try {
      return parseCredentialJson(await readFile(join(configDir, '.credentials.json')));
    } catch {
      return null;
    }
  }

  async function read(configDir: string): Promise<CredentialsResult> {
    const cached = cache.get(configDir);
    if (cached && cached.until > now()) return cached.result;
    cache.delete(configDir);

    const candidates = await readKeychain(configDir);
    if (!candidates.some((c) => !isExpired(c))) {
      const fileCreds = await readFileCreds(configDir);
      if (fileCreds) candidates.push(fileCreds);
    }

    const valid = candidates.find((c) => !isExpired(c));
    if (valid) {
      const result: OkResult = { status: 'ok', ...valid };
      cache.set(configDir, { result, until: valid.expiresAt ?? now() + NO_EXPIRY_CACHE_MS });
      return result;
    }
    const expired = candidates[0];
    if (expired && expired.expiresAt != null) return { status: 'token_expired', expiresAt: expired.expiresAt };
    return { status: 'no_credentials' };
  }

  return {
    read,
    invalidate(configDir: string): void {
      cache.delete(configDir);
    },
    async deleteKeychainItem(configDir: string): Promise<void> {
      cache.delete(configDir);
      if (platform !== 'darwin') return;
      try {
        await execFile(SECURITY_BIN, ['delete-generic-password', '-s', serviceName(configDir)], {
          timeout: KEYCHAIN_TIMEOUT_MS,
        });
      } catch {
        // no item for this config dir
      }
    },
  };
}
