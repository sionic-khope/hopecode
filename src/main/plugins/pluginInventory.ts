// Read-only inventory of the shared Claude config (~/.claude, linked into every account): installed plugins,
// skills, agents, output styles, MCP servers and hooks. Nothing here ever writes; an entry that cannot be parsed
// is skipped and reported in `problems`.
import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { isStrictlyInside } from '../containment';
import type { PluginInventory, PluginItem, PluginProblem } from '../../shared/nav';

/** Only the head of a markdown file is read (frontmatter). */
const HEAD_BYTES = 64 * 1024;
const JSON_MAX_BYTES = 4 * 1024 * 1024;
const MAX_DIR_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

/**
 * Flat `key: value` pairs of a leading `---` frontmatter block (block scalars `|` / `>` are joined into one line).
 * Returns null when the file has no frontmatter.
 */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const out: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if (/^[|>][-+]?$/.test(value.trim())) {
      const block: string[] = [];
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      value = block.join(' ');
    }
    out[key] = unquote(value);
  }
  return out;
}

export interface InstalledPlugin {
  /** `name@marketplace` key. */
  key: string;
  name: string;
  marketplace: string | null;
  version: string | null;
  installPath: string | null;
}

/** `plugins/installed_plugins.json` (v1: one record per key, v2: a list of installs per key). Throws on bad JSON. */
export function parseInstalledPlugins(text: string): InstalledPlugin[] {
  const raw: unknown = JSON.parse(text);
  if (!isObj(raw) || !isObj(raw.plugins)) throw new Error('plugins 항목이 없습니다');
  const out: InstalledPlugin[] = [];
  for (const [key, value] of Object.entries(raw.plugins)) {
    const record = Array.isArray(value) ? value.find(isObj) : isObj(value) ? value : undefined;
    const at = key.lastIndexOf('@');
    out.push({
      key,
      name: at > 0 ? key.slice(0, at) : key,
      marketplace: at > 0 ? key.slice(at + 1) : null,
      version: record && typeof record.version === 'string' ? record.version : null,
      installPath: record && typeof record.installPath === 'string' ? record.installPath : null,
    });
  }
  return out;
}

export interface SharedSettings {
  enabledPlugins: Record<string, boolean>;
  hooks: PluginItem[];
  mcp: PluginItem[];
}

function commandOf(spec: Record<string, unknown>): string | undefined {
  if (typeof spec.command === 'string') {
    const args = Array.isArray(spec.args) ? spec.args.filter((a): a is string => typeof a === 'string') : [];
    return [spec.command, ...args].join(' ');
  }
  if (typeof spec.url === 'string') return spec.url;
  return undefined;
}

/** MCP server map (`{name: {command, args} | {type, url}}`) -> items. */
export function mcpItems(servers: unknown, source: string, enabled: boolean | null): PluginItem[] {
  if (!isObj(servers)) return [];
  return Object.entries(servers)
    .filter(([, spec]) => isObj(spec))
    .map(([name, spec]) => {
      const s = spec as Record<string, unknown>;
      const detail = commandOf(s);
      return {
        kind: 'mcp' as const,
        name,
        description: typeof s.type === 'string' ? `${s.type} 서버` : null,
        source,
        enabled,
        ...(detail ? { detail } : {}),
      };
    });
}

/** settings.json: `enabledPlugins`, `hooks` (event -> matchers -> commands), `mcpServers`. Throws on bad JSON. */
export function parseSharedSettings(text: string): SharedSettings {
  const raw: unknown = JSON.parse(text);
  if (!isObj(raw)) throw new Error('객체가 아닙니다');
  const enabledPlugins: Record<string, boolean> = {};
  if (isObj(raw.enabledPlugins)) {
    for (const [key, value] of Object.entries(raw.enabledPlugins)) enabledPlugins[key] = value === true;
  }
  const hooksOn = raw.disableAllHooks !== true;
  const hooks: PluginItem[] = [];
  if (isObj(raw.hooks)) {
    for (const [event, matchers] of Object.entries(raw.hooks)) {
      if (!Array.isArray(matchers)) continue;
      for (const matcher of matchers) {
        if (!isObj(matcher)) continue;
        const commands = Array.isArray(matcher.hooks)
          ? matcher.hooks.filter(isObj).map((h) => (typeof h.command === 'string' ? h.command : typeof h.type === 'string' ? h.type : ''))
          : [];
        const scope = typeof matcher.matcher === 'string' && matcher.matcher ? ` (${matcher.matcher})` : '';
        hooks.push({
          kind: 'hook',
          name: `${event}${scope}`,
          description: commands.filter(Boolean).join(' · ') || null,
          source: 'settings.json',
          enabled: hooksOn,
        });
      }
    }
  }
  return { enabledPlugins, hooks, mcp: mcpItems(raw.mcpServers, 'settings.json', true) };
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

async function readHead(path: string, max: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function readJsonText(path: string): Promise<string | null> {
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return null;
  if (st.size > JSON_MAX_BYTES) throw new Error('파일이 너무 큽니다');
  return readHead(path, st.size);
}

async function listDir(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch((): string[] => []);
  return names.filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b)).slice(0, MAX_DIR_ENTRIES);
}

function message(err: unknown): string {
  if (err instanceof SyntaxError) return `JSON을 읽을 수 없습니다: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Reads the shared config folder. `sourceDir` is fixed by main (never from the renderer). */
export async function readPluginInventory(sourceDir: string): Promise<PluginInventory> {
  const root = resolve(sourceDir);
  const items: PluginItem[] = [];
  const problems: PluginProblem[] = [];
  const rel = (p: string) => relative(root, p) || '.';
  const problem = (path: string, err: unknown) => problems.push({ path: rel(path), message: message(err) });

  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return { sourceDir: root, exists: false, items, problems };

  // settings.json first: it says which plugins are enabled.
  let settings: SharedSettings = { enabledPlugins: {}, hooks: [], mcp: [] };
  const settingsPath = join(root, 'settings.json');
  try {
    const text = await readJsonText(settingsPath);
    if (text !== null) settings = parseSharedSettings(text);
  } catch (err) {
    problem(settingsPath, err);
  }

  const pluginsPath = join(root, 'plugins', 'installed_plugins.json');
  const pluginMcp: PluginItem[] = [];
  try {
    const text = await readJsonText(pluginsPath);
    for (const plugin of text !== null ? parseInstalledPlugins(text) : []) {
      const enabled = plugin.key in settings.enabledPlugins ? settings.enabledPlugins[plugin.key]! : null;
      let description: string | null = null;
      // Only files inside the shared folder are read (installPath comes from a file, not from us).
      const installPath = plugin.installPath && isStrictlyInside(root, plugin.installPath) ? resolve(plugin.installPath) : null;
      if (installPath) {
        const manifestPath = join(installPath, '.claude-plugin', 'plugin.json');
        try {
          const manifestText = await readJsonText(manifestPath);
          if (manifestText !== null) {
            const manifest: unknown = JSON.parse(manifestText);
            if (isObj(manifest)) {
              if (typeof manifest.description === 'string') description = manifest.description;
              pluginMcp.push(...mcpItems(manifest.mcpServers, plugin.name, enabled));
            }
          }
          const mcpText = await readJsonText(join(installPath, '.mcp.json'));
          if (mcpText !== null) {
            const mcp: unknown = JSON.parse(mcpText);
            pluginMcp.push(...mcpItems(isObj(mcp) && isObj(mcp.mcpServers) ? mcp.mcpServers : mcp, plugin.name, enabled));
          }
        } catch (err) {
          problem(manifestPath, err);
        }
      }
      items.push({
        kind: 'plugin',
        name: plugin.name,
        description,
        source: plugin.marketplace ?? '로컬',
        enabled,
        ...(plugin.version ? { detail: `v${plugin.version}` } : {}),
      });
    }
  } catch (err) {
    problem(pluginsPath, err);
  }

  const skillsDir = join(root, 'skills');
  for (const name of await listDir(skillsDir)) {
    const file = join(skillsDir, name, 'SKILL.md');
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    try {
      const fm = parseFrontmatter(await readHead(file, HEAD_BYTES));
      if (!fm) throw new Error('frontmatter가 없습니다');
      items.push({ kind: 'skill', name: fm.name || name, description: fm.description || null, source: '사용자', enabled: null });
    } catch (err) {
      problem(file, err);
    }
  }

  for (const [dirName, kind] of [
    ['agents', 'agent'],
    ['output-styles', 'output-style'],
  ] as const) {
    const dir = join(root, dirName);
    for (const name of await listDir(dir)) {
      if (!name.endsWith('.md')) continue;
      const file = join(dir, name);
      try {
        const fm = parseFrontmatter(await readHead(file, HEAD_BYTES));
        if (!fm) throw new Error('frontmatter가 없습니다');
        items.push({ kind, name: fm.name || name.slice(0, -3), description: fm.description || null, source: '사용자', enabled: null });
      } catch (err) {
        problem(file, err);
      }
    }
  }

  items.push(...settings.mcp, ...pluginMcp, ...settings.hooks);
  const hooksDir = join(root, 'hooks');
  for (const name of await listDir(hooksDir)) {
    const st = await stat(join(hooksDir, name)).catch(() => null);
    if (!st?.isFile()) continue;
    items.push({ kind: 'hook', name, description: 'settings.json의 hooks에서 참조할 때 실행됩니다', source: 'hooks/', enabled: null });
  }

  return { sourceDir: root, exists: true, items, problems };
}
