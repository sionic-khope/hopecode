// Claude Code slash commands for the composer's `/` picker: a read-only scan of the shared ~/.claude (skills,
// commands, enabled plugins) and of a trusted project's .claude, merged with the live Query's supportedCommands().
// Main process only. Every file is opened by its realpath and only when that lies inside an allowed root (a
// symlink pointing elsewhere is skipped); files above MAX_COMMAND_FILE_BYTES and anything past MAX_COMMAND_FILES
// are left out. Nothing here ever writes.
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isStrictlyInside } from '../containment';
import { parseFrontmatter, parseInstalledPlugins, parseSharedSettings } from '../plugins/pluginInventory';
import type { SlashCommandInfo, SlashCommandList } from '../../shared/types';
import type { SlashCommandLite } from '../contracts';
import { t } from '../../shared/i18n';

export const MAX_COMMAND_FILE_BYTES = 256 * 1024;
export const MAX_COMMAND_FILES = 400;
/** Lines of body text shown in the picker's preview. */
export const PREVIEW_LINES = 40;
const PREVIEW_CHARS = 8 * 1024;
const MAX_DESCRIPTION_CHARS = 1000;
const MAX_HINT_CHARS = 200;
const MAX_DIR_ENTRIES = 500;
/** `commands/a/b/c.md` -> `a:b:c`; deeper folders are not walked. */
const MAX_COMMAND_DEPTH = 3;
const LIVE_TIMEOUT_MS = 3000;
const JSON_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Claude Code built-ins that make sense in a chat window. Only the ones the live session reports
 * (supportedCommands, `builtin: true`) are listed; terminal-bound ones (/exit, /statusline, /vim …) never are.
 */
export const GUI_BUILTINS: ReadonlySet<string> = new Set([
  'compact',
  'clear',
  'context',
  'cost',
  'usage',
  'init',
  'review',
  'security-review',
  'pr-comments',
  'release-notes',
  'todos',
]);

/** Before any session reported its list: the two built-ins the Agent SDK documents for headless sessions. */
export function fallbackBuiltins(): SlashCommandInfo[] {
  return [
    { name: 'compact', description: t('slash.compact'), argumentHint: null, source: 'builtin', kind: 'builtin' },
    { name: 'clear', description: t('slash.clear'), argumentHint: null, source: 'builtin', kind: 'builtin' },
  ];
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/** Frontmatter (or null) and the text after it. */
export function splitFrontmatter(text: string): { meta: Record<string, string> | null; body: string } {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { meta: null, body: clean };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { meta: null, body: clean };
  return { meta: parseFrontmatter(clean), body: lines.slice(end + 1).join('\n') };
}

/** First PREVIEW_LINES lines of the body (leading blank lines dropped), capped in characters. */
export function bodyPreview(body: string): string {
  const lines = body.split(/\r?\n/);
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  const head = lines.slice(0, PREVIEW_LINES).join('\n').trimEnd();
  return head.length > PREVIEW_CHARS ? head.slice(0, PREVIEW_CHARS) : head;
}

const cap = (v: string, max: number) => (v.length > max ? v.slice(0, max) : v);

function firstTextLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t;
  }
  return '';
}

/**
 * One skill / command file -> picker row; null when it opts out of `/` (`user-invocable: false`).
 * Commands without a description use their first line of text, as Claude Code does.
 */
export function commandFromFile(
  text: string,
  info: Pick<SlashCommandInfo, 'name' | 'source' | 'kind' | 'plugin' | 'path'>,
): SlashCommandInfo | null {
  const { meta, body } = splitFrontmatter(text);
  if (meta?.['user-invocable']?.toLowerCase() === 'false') return null;
  const description = meta?.description?.trim() || (info.kind === 'command' ? firstTextLine(body) : '');
  const hint = meta?.['argument-hint']?.trim() ?? '';
  return {
    ...info,
    description: cap(description, MAX_DESCRIPTION_CHARS),
    argumentHint: hint ? cap(hint, MAX_HINT_CHARS) : null,
    preview: bodyPreview(body),
  };
}

/**
 * Scanned rows + the live session's list. Same name: the scanned row (path, preview) wins and borrows a missing
 * description / hint. Live-only rows are `session` (MCP prompts, synced skills …); built-ins are the live
 * session's GUI_BUILTINS, else `fallback`.
 */
export function mergeSlashCommands(
  scanned: readonly SlashCommandInfo[],
  live: readonly SlashCommandLite[] | null,
  fallback: readonly SlashCommandInfo[] = fallbackBuiltins(),
): SlashCommandList {
  const byName = new Map<string, SlashCommandInfo>();
  for (const c of scanned) if (!byName.has(c.name)) byName.set(c.name, { ...c });
  const builtins: SlashCommandInfo[] = [];
  const sessionOnly: SlashCommandInfo[] = [];
  if (live) {
    for (const c of live) {
      if (typeof c?.name !== 'string' || !c.name) continue;
      const description = typeof c.description === 'string' ? cap(c.description, MAX_DESCRIPTION_CHARS) : '';
      const hint = typeof c.argumentHint === 'string' && c.argumentHint.trim() ? cap(c.argumentHint.trim(), MAX_HINT_CHARS) : null;
      if (c.builtin) {
        if (GUI_BUILTINS.has(c.name) && !builtins.some((b) => b.name === c.name)) {
          builtins.push({ name: c.name, description, argumentHint: hint, source: 'builtin', kind: 'builtin' });
        }
        continue;
      }
      const known = byName.get(c.name);
      if (known) {
        if (!known.description) known.description = description;
        if (!known.argumentHint) known.argumentHint = hint;
      } else if (!sessionOnly.some((s) => s.name === c.name)) {
        sessionOnly.push({ name: c.name, description, argumentHint: hint, source: 'session', kind: 'skill' });
      }
    }
  }
  const shown = live ? builtins : fallback.filter((b) => !byName.has(b.name));
  const taken = new Set(byName.keys());
  return {
    commands: [...byName.values(), ...sessionOnly, ...shown.filter((b) => !taken.has(b.name))],
    origin: live ? 'session' : 'scan',
  };
}

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Shared Claude config folder (~/.claude; fixture runs: a temp folder). Fixed by main. */
  userDir: string;
  /**
   * Extra folders user skills may resolve into through a symlink (skills.sh installs ~/.claude/skills/x as a link
   * to ~/.agents/skills/x). Anything else outside the roots is skipped.
   */
  extraRoots?: readonly string[];
  /** Trusted project folder (its .claude/skills, .claude/commands); null = none. */
  projectDir?: string | null;
  maxFiles?: number;
  maxFileBytes?: number;
}

interface Budget {
  left: number;
  maxBytes: number;
}

async function realRoot(dir: string): Promise<string | null> {
  const real = await realpath(dir).catch(() => null);
  if (!real) return null;
  const st = await stat(real).catch(() => null);
  return st?.isDirectory() ? real : null;
}

const within = (roots: readonly string[], real: string) => roots.some((r) => isStrictlyInside(r, real));

/**
 * File contents when its realpath is strictly inside one of `roots` (realpaths), it is a regular file and at most
 * `maxBytes`; else null.
 */
export async function readContained(file: string, roots: readonly string[], maxBytes: number): Promise<string | null> {
  const real = await realpath(file).catch(() => null);
  if (!real || !within(roots, real)) return null;
  const st = await stat(real).catch(() => null);
  if (!st?.isFile() || st.size > maxBytes) return null;
  const fh = await open(real, 'r').catch(() => null);
  if (!fh) return null;
  try {
    // One byte more than allowed: a file that grew after stat() is refused too.
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return null;
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function listDir(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch((): string[] => []);
  return names.filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b)).slice(0, MAX_DIR_ENTRIES);
}

interface Origin {
  source: SlashCommandInfo['source'];
  plugin?: string;
  /** `plugin:` prefix of plugin command names. */
  prefix: string;
}

async function scanSkills(dir: string, roots: readonly string[], origin: Origin, budget: Budget, out: SlashCommandInfo[]): Promise<void> {
  for (const name of await listDir(dir)) {
    if (budget.left <= 0) return;
    const file = join(dir, name, 'SKILL.md');
    const text = await readContained(file, roots, budget.maxBytes);
    if (text === null) continue;
    budget.left -= 1;
    const row = commandFromFile(text, {
      name: `${origin.prefix}${name}`,
      source: origin.source,
      kind: 'skill',
      path: file,
      ...(origin.plugin ? { plugin: origin.plugin } : {}),
    });
    if (row) out.push(row);
  }
}

async function scanCommands(
  dir: string,
  roots: readonly string[],
  origin: Origin,
  budget: Budget,
  out: SlashCommandInfo[],
  segments: string[] = [],
): Promise<void> {
  for (const name of await listDir(dir)) {
    if (budget.left <= 0) return;
    const path = join(dir, name);
    if (name.endsWith('.md')) {
      const text = await readContained(path, roots, budget.maxBytes);
      if (text === null) continue;
      budget.left -= 1;
      const row = commandFromFile(text, {
        name: `${origin.prefix}${[...segments, name.slice(0, -3)].join(':')}`,
        source: origin.source,
        kind: 'command',
        path,
        ...(origin.plugin ? { plugin: origin.plugin } : {}),
      });
      if (row) out.push(row);
      continue;
    }
    if (segments.length + 1 >= MAX_COMMAND_DEPTH) continue;
    const real = await realpath(path).catch(() => null);
    if (!real || !within(roots, real)) continue;
    const st = await stat(real).catch(() => null);
    if (st?.isDirectory()) await scanCommands(path, roots, origin, budget, out, [...segments, name]);
  }
}

/** Enabled plugins (installed_plugins.json + settings.json `enabledPlugins`) whose install folder is inside `root`. */
async function enabledPlugins(userDir: string, roots: readonly string[]): Promise<{ name: string; dir: string }[]> {
  const installedText = await readContained(join(userDir, 'plugins', 'installed_plugins.json'), roots, JSON_MAX_BYTES);
  if (installedText === null) return [];
  let enabled: Record<string, boolean> = {};
  const settingsText = await readContained(join(userDir, 'settings.json'), roots, JSON_MAX_BYTES);
  try {
    if (settingsText !== null) enabled = parseSharedSettings(settingsText).enabledPlugins;
  } catch {
    enabled = {};
  }
  let installed: ReturnType<typeof parseInstalledPlugins> = [];
  try {
    installed = parseInstalledPlugins(installedText);
  } catch {
    return [];
  }
  const out: { name: string; dir: string }[] = [];
  for (const p of installed) {
    if (enabled[p.key] === false || !p.installPath) continue;
    const real = await realRoot(p.installPath);
    if (!real || !within(roots, real)) continue;
    out.push({ name: p.name, dir: real });
  }
  return out;
}

/** Skills and commands of ~/.claude, a trusted project's .claude and the enabled plugins (in that order, deduped). */
export async function scanSlashCommands(o: ScanOptions): Promise<SlashCommandInfo[]> {
  const budget: Budget = { left: o.maxFiles ?? MAX_COMMAND_FILES, maxBytes: o.maxFileBytes ?? MAX_COMMAND_FILE_BYTES };
  const out: SlashCommandInfo[] = [];
  const userRoot = await realRoot(o.userDir);
  // Folders are walked by the given paths (shown in the preview); containment compares realpaths.
  if (o.projectDir) {
    const projectRoot = await realRoot(o.projectDir);
    if (projectRoot) {
      const origin: Origin = { source: 'project', prefix: '' };
      await scanSkills(join(o.projectDir, '.claude', 'skills'), [projectRoot], origin, budget, out);
      await scanCommands(join(o.projectDir, '.claude', 'commands'), [projectRoot], origin, budget, out);
    }
  }
  if (userRoot) {
    const extra = (await Promise.all((o.extraRoots ?? []).map(realRoot))).filter((r): r is string => r !== null);
    const userRoots = [userRoot, ...extra];
    const origin: Origin = { source: 'user', prefix: '' };
    await scanSkills(join(o.userDir, 'skills'), userRoots, origin, budget, out);
    await scanCommands(join(o.userDir, 'commands'), [userRoot], origin, budget, out);
    for (const plugin of await enabledPlugins(o.userDir, [userRoot])) {
      const pluginOrigin: Origin = { source: 'plugin', plugin: plugin.name, prefix: `${plugin.name}:` };
      await scanSkills(join(plugin.dir, 'skills'), [plugin.dir], pluginOrigin, budget, out);
      await scanCommands(join(plugin.dir, 'commands'), [plugin.dir], pluginOrigin, budget, out);
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

// ---------------------------------------------------------------------------
// Service (commands:list)
// ---------------------------------------------------------------------------

export interface SlashCommandService {
  /** `threadId`: its live Query's list is merged in when one is open. `projectDir`: trusted folder or null. */
  list(target: { threadId: string | null; projectDir: string | null }): Promise<SlashCommandList>;
}

export interface SlashCommandServiceDeps {
  userDir: string;
  extraRoots?: readonly string[];
  /** SessionManager.supportedCommands. */
  live(threadId: string): Promise<SlashCommandLite[]> | null;
  log?: (message: string, err?: unknown) => void;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function createSlashCommandService(deps: SlashCommandServiceDeps): SlashCommandService {
  return {
    async list({ threadId, projectDir }) {
      const pending = threadId ? deps.live(threadId) : null;
      const [scanned, live] = await Promise.all([
        scanSlashCommands({ userDir: deps.userDir, extraRoots: deps.extraRoots ?? [], projectDir }).catch((err: unknown) => {
          deps.log?.('[commands] scan failed', err);
          return [] as SlashCommandInfo[];
        }),
        pending ? withTimeout(pending, LIVE_TIMEOUT_MS) : Promise.resolve(null),
      ]);
      return mergeSlashCommands(scanned, Array.isArray(live) ? live : null);
    },
  };
}
