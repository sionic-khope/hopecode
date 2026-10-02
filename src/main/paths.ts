// Single source of on-disk locations (plan 3.2). HOPECODE_HOME isolates e2e runs.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { ENV_HOPECODE_HOME } from '../shared/constants';

/** Dev/test-only env overrides are ignored in a packaged app (L2). `app` is absent outside Electron (unit tests). */
export function devOverridesAllowed(): boolean {
  return (app as typeof app | undefined)?.isPackaged !== true;
}

/** `process.env[name]`, or undefined in a packaged app. */
export function devEnv(name: string): string | undefined {
  return devOverridesAllowed() ? process.env[name] : undefined;
}

function overrideRoot(): string | null {
  const v = devEnv(ENV_HOPECODE_HOME);
  return v && v.trim() ? resolve(v) : null;
}

/** `~/.hopecode` or `$HOPECODE_HOME/home`. */
export function hopecodeHome(): string {
  const root = overrideRoot();
  return root ? join(root, 'home') : join(homedir(), '.hopecode');
}

/**
 * Folder name of Electron userData under appData. The app was renamed Hopecode -> deltax; Electron would derive
 * `deltax` from productName, so the old name is kept: settings, threads, Local Storage and the single-instance lock
 * stay where they are, nothing is moved, and the old and new app can never run on the same data at once.
 */
export const USER_DATA_DIR_NAME = 'Hopecode';

/** userData path for an appData dir (`~/Library/Application Support`). Pure: never touches the disk. */
export function userDataDirIn(appDataDir: string): string {
  return join(appDataDir, USER_DATA_DIR_NAME);
}

/** Electron userData (`~/Library/Application Support/Hopecode` or `$HOPECODE_HOME/userData`). */
export function userDataDir(): string {
  const root = overrideRoot();
  return root ? join(root, 'userData') : app.getPath('userData');
}

/** Account CLAUDE_CONFIG_DIR parent. Absolute, no trailing slash. */
export function accountsDir(): string {
  return join(hopecodeHome(), 'accounts');
}

export function worktreesDir(): string {
  return join(hopecodeHome(), 'worktrees');
}

/** Root of the per-thread folders of chats without a project (`<root>/<threadId>`, 0700, no git). */
export function scratchDir(): string {
  return join(hopecodeHome(), 'scratch');
}

/**
 * This Mac's own Claude Code config dir (`~/.claude`), the `local-default` account's configDir. Under a
 * HOPECODE_HOME override (dev / e2e) it is `$HOPECODE_HOME/home/fake-claude`, so tests never touch the real one.
 * Every local-account check, path guard and detector uses this function (no other `homedir()` + `.claude`).
 */
export function localClaudeDir(): string {
  return overrideRoot() ? join(hopecodeHome(), 'fake-claude') : join(homedir(), '.claude');
}

/** Must run before `app.ready`. */
export function initPaths(): void {
  const root = overrideRoot();
  app.setPath('userData', root ? join(root, 'userData') : userDataDirIn(app.getPath('appData')));
}
