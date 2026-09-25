// Share user config from ~/.claude into an account config dir via absolute symlinks (plan 3.2, 4.2).
// Only SHARED_CONFIG_ENTRIES are linked; auth files, `.claude.json` and `projects/` stay per account.
// Never writes to the source dir.
import { lstat, readdir, readlink, rm, stat, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SHARED_CONFIG_ENTRIES } from '../../shared/constants';
import type { ConfigDirLinks } from '../contracts';

export function defaultClaudeDir(): string {
  return join(homedir(), '.claude');
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

export async function linkSharedConfig(
  configDir: string,
  sourceDir: string = defaultClaudeDir(),
  warn: (msg: string) => void = console.warn,
): Promise<{ linked: string[]; skipped: string[] }> {
  const src = resolve(sourceDir);
  const linked: string[] = [];
  const skipped: string[] = [];
  for (const name of SHARED_CONFIG_ENTRIES) {
    const source = join(src, name);
    if (!(await lstatOrNull(source))) continue; // only link what exists
    const target = join(configDir, name);
    const existing = await lstatOrNull(target);
    if (existing) {
      if (existing.isSymbolicLink() && (await readlink(target)) === source) {
        linked.push(name); // already linked (idempotent)
      } else {
        warn(`[hopecode] ${target} already exists; not replacing with link to ${source}`);
        skipped.push(name);
      }
      continue;
    }
    await symlink(source, target);
    linked.push(name);
  }
  return { linked, skipped };
}

/** Shared-entry symlinks whose target no longer resolves. */
export async function verifyLinks(configDir: string): Promise<{ broken: string[] }> {
  const broken: string[] = [];
  for (const name of SHARED_CONFIG_ENTRIES) {
    const p = join(configDir, name);
    const st = await lstatOrNull(p);
    if (!st?.isSymbolicLink()) continue;
    try {
      await stat(p);
    } catch {
      broken.push(name);
    }
  }
  return { broken };
}

/**
 * Delete an account config dir without touching shared originals: every top-level symlink is unlinked
 * first (lstat, never followed), then the remaining real files are removed.
 */
export async function removeConfigDir(configDir: string): Promise<void> {
  const st = await lstatOrNull(configDir);
  if (!st) return;
  if (st.isSymbolicLink()) {
    await unlink(configDir);
    return;
  }
  for (const name of await readdir(configDir)) {
    const p = join(configDir, name);
    if ((await lstatOrNull(p))?.isSymbolicLink()) await unlink(p);
  }
  await rm(configDir, { recursive: true, force: true });
}

export function createConfigDirLinks(defaultSourceDir: string = defaultClaudeDir()): ConfigDirLinks {
  return {
    linkSharedConfig: (configDir, sourceDir) => linkSharedConfig(configDir, sourceDir ?? defaultSourceDir),
    verifyLinks,
  };
}
