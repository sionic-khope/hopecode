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

/** Must run before `app.ready`. */
export function initPaths(): void {
  const root = overrideRoot();
  if (root) app.setPath('userData', join(root, 'userData'));
}
