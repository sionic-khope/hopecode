// Fixture-mode (`HOPECODE_FIXTURES=1`, e2e) replacements for everything that would touch the network,
// the Keychain, the real `claude` CLI or a native dialog. Wired by src/main/index.ts.
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { HOUR_MS, DAY_MS } from '../../shared/constants';
import type { Account } from '../../shared/types';
import type { PtyLike, RunCommandFn, SpawnPtyFn } from '../accounts/loginFlow';
import type { Credentials, Dialogs, Store, UsageClient } from '../contracts';

interface FixtureAccountSpec {
  id: string;
  alias: string;
  color: string;
  email: string;
  fiveHour: number;
  sevenDay: number;
  fable: number;
}

/** Pool of three accounts at 100 / 40 / 0 % (5h) -> statusline `47%`, `2/3 avail`. */
export const FIXTURE_ACCOUNTS: readonly FixtureAccountSpec[] = [
  { id: 'fixture-work', alias: 'Work', color: '#007AFF', email: 'work@example.com', fiveHour: 100, sevenDay: 62, fable: 30 },
  { id: 'fixture-personal', alias: 'Personal', color: '#34C759', email: 'personal@example.com', fiveHour: 40, sevenDay: 20, fable: 10 },
  { id: 'fixture-spare', alias: 'Spare', color: '#FF9500', email: 'spare@example.com', fiveHour: 0, sevenDay: 5, fable: 0 },
];

/** Seed the fixture pool into an empty store (first launch of a fresh HOPECODE_HOME). */
export function seedFixtureAccounts(store: Pick<Store, 'get' | 'update'>, accountsDir: string, now = Date.now()): void {
  if (store.get().accounts.length > 0) return;
  const accounts: Account[] = FIXTURE_ACCOUNTS.map((spec, i) => {
    const configDir = join(accountsDir, spec.id);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    return {
      id: spec.id,
      alias: spec.alias,
      color: spec.color,
      email: spec.email,
      plan: 'max',
      configDir,
      priority: i,
      enabled: true,
      createdAt: now,
    };
  });
  store.update((draft) => {
    draft.accounts.push(...accounts);
  });
}

/** Credentials that never read the Keychain or disk; the access token is the config dir name. */
export function createFixtureCredentials(): Credentials {
  return {
    async read(configDir) {
      return { status: 'ok', accessToken: basename(configDir), expiresAt: null, subscriptionType: 'max', rateLimitTier: null };
    },
    invalidate() {},
    async deleteKeychainItem() {},
  };
}

/** `/api/oauth/usage` stand-in: fixture accounts report their spec, any other account reports 0%. */
export function createFixtureUsageClient(now: () => number = Date.now): UsageClient {
  return {
    async fetchUsage(accessToken) {
      const spec = FIXTURE_ACCOUNTS.find((a) => a.id === accessToken);
      const t = now();
      const iso = (ms: number) => new Date(ms).toISOString();
      return {
        status: 'ok',
        data: {
          five_hour: { utilization: spec?.fiveHour ?? 0, resets_at: iso(t + 2 * HOUR_MS) },
          seven_day: { utilization: spec?.sevenDay ?? 0, resets_at: iso(t + 3 * DAY_MS) },
          limits: [
            {
              kind: 'weekly_scoped',
              percent: spec?.fable ?? 0,
              resets_at: iso(t + 3 * DAY_MS),
              is_active: true,
              scope: { model: { id: 'claude-fable-5', display_name: 'Fable' } },
            },
          ],
          extra_usage: { is_enabled: false },
        },
      };
    },
  };
}

/** Scripted `claude auth login --claudeai` pty: prints a URL, then exits 0 (no browser is opened). */
export const fixtureSpawnPty: SpawnPtyFn = () => {
  let dataCb: ((data: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number }) => void) | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
  later(100, () => dataCb?.('Opening browser to sign in…\r\nhttps://claude.ai/oauth/authorize?fixture=1\r\n'));
  later(600, () => dataCb?.('Login successful.\r\n'));
  later(700, () => exitCb?.({ exitCode: 0 }));
  const pty: PtyLike = {
    onData: (cb) => (dataCb = cb),
    onExit: (cb) => (exitCb = cb),
    write: () => {},
    kill: () => {
      timers.forEach(clearTimeout);
      exitCb?.({ exitCode: 1 });
    },
  };
  return pty;
};

/** Scripted `claude auth status --json`; every login gets a new address. */
export function createFixtureRunCommand(): RunCommandFn {
  let n = 0;
  return async () => {
    n += 1;
    return {
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: `fixture-${n}@example.com`, subscriptionType: 'max' }),
    };
  };
}

/**
 * Native dialog seam for e2e: `project:add` returns HOPECODE_FIXTURE_PROJECT, the trust question answers
 * Trust and the bypassPermissions warning is confirmed, so no native dialog ever blocks a test.
 */
export function createFixtureDialogs(projectPath: string | undefined): Dialogs {
  return {
    async pickProjectFolder() {
      return projectPath && projectPath.trim() ? projectPath : null;
    },
    async confirmTrustProject() {
      return 'trust';
    },
    async confirmBypassPermissions() {
      return true;
    },
  };
}
