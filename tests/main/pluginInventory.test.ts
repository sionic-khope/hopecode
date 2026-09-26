import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseFrontmatter,
  parseInstalledPlugins,
  parseSharedSettings,
  readPluginInventory,
} from '../../src/main/plugins/pluginInventory';

describe('parseFrontmatter', () => {
  it('reads flat keys, quotes and block scalars', () => {
    const fm = parseFrontmatter('---\nname: "reviewer"\ndescription: >\n  Reviews code\n  carefully\nmodel: sonnet\n---\n# body\n');
    expect(fm).toEqual({ name: 'reviewer', description: 'Reviews code carefully', model: 'sonnet' });
  });

  it('null without a frontmatter block', () => {
    expect(parseFrontmatter('# just markdown')).toBeNull();
    expect(parseFrontmatter('---\nname: x\n')).toBeNull();
  });
});

describe('parseInstalledPlugins', () => {
  it('v2 (list per key) and v1 (record per key)', () => {
    const v2 = parseInstalledPlugins(
      JSON.stringify({ version: 2, plugins: { 'fmt@tools': [{ scope: 'user', installPath: '/x/fmt', version: '1.2.0' }] } }),
    );
    expect(v2).toEqual([{ key: 'fmt@tools', name: 'fmt', marketplace: 'tools', version: '1.2.0', installPath: '/x/fmt' }]);
    const v1 = parseInstalledPlugins(JSON.stringify({ version: 1, plugins: { local: { version: '0.1' } } }));
    expect(v1).toEqual([{ key: 'local', name: 'local', marketplace: null, version: '0.1', installPath: null }]);
  });

  it('throws on broken files', () => {
    expect(() => parseInstalledPlugins('{not json')).toThrow();
    expect(() => parseInstalledPlugins('{"version":2}')).toThrow();
  });
});

describe('parseSharedSettings', () => {
  it('enabled plugins, hooks per matcher and MCP servers', () => {
    const s = parseSharedSettings(
      JSON.stringify({
        enabledPlugins: { 'fmt@tools': true, 'old@tools': false },
        hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] },
        mcpServers: { files: { command: 'npx', args: ['-y', 'files-mcp'] } },
      }),
    );
    expect(s.enabledPlugins).toEqual({ 'fmt@tools': true, 'old@tools': false });
    expect(s.hooks).toEqual([
      { kind: 'hook', name: 'PostToolUse (Edit)', description: 'prettier --write', source: 'settings.json', enabled: true },
    ]);
    expect(s.mcp).toEqual([
      { kind: 'mcp', name: 'files', description: null, source: 'settings.json', enabled: true, detail: 'npx -y files-mcp' },
    ]);
  });

  it('disableAllHooks marks hooks off', () => {
    const s = parseSharedSettings(JSON.stringify({ disableAllHooks: true, hooks: { Stop: [{ hooks: [{ command: 'say done' }] }] } }));
    expect(s.hooks[0]).toMatchObject({ name: 'Stop', enabled: false });
  });
});

describe('readPluginInventory (fake shared folder)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hopecode-plugins-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (rel: string, text: string) => {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };

  it('missing folder: exists=false, nothing else', async () => {
    const inv = await readPluginInventory(join(root, 'nope'));
    expect(inv).toMatchObject({ exists: false, items: [], problems: [] });
  });

  it('lists every kind and skips (reports) broken entries', async () => {
    const installPath = join(root, 'plugins', 'cache', 'tools', 'fmt', '1.2.0');
    write(
      'plugins/installed_plugins.json',
      JSON.stringify({
        version: 2,
        plugins: {
          'fmt@tools': [{ installPath, version: '1.2.0' }],
          'outside@tools': [{ installPath: '/etc', version: '1' }],
        },
      }),
    );
    write('plugins/cache/tools/fmt/1.2.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'fmt', description: 'Formats code' }));
    write('plugins/cache/tools/fmt/1.2.0/.mcp.json', JSON.stringify({ mcpServers: { fmtd: { type: 'stdio', command: 'fmtd' } } }));
    write('settings.json', JSON.stringify({ enabledPlugins: { 'fmt@tools': true }, hooks: { Stop: [{ hooks: [{ command: 'say done' }] }] } }));
    write('skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship it\n---\n');
    write('skills/broken/SKILL.md', 'no frontmatter here');
    write('agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews diffs\n---\n');
    write('agents/notes.txt', 'ignored');
    write('output-styles/terse.md', '---\ndescription: Short answers\n---\n');
    write('hooks/notify.sh', '#!/bin/sh\n');

    const inv = await readPluginInventory(root);
    expect(inv.exists).toBe(true);
    const byKind = (kind: string) => inv.items.filter((i) => i.kind === kind);
    expect(byKind('plugin')).toEqual([
      { kind: 'plugin', name: 'fmt', description: 'Formats code', source: 'tools', enabled: true, detail: 'v1.2.0' },
      // installPath outside the shared folder is never read (no description), still listed.
      { kind: 'plugin', name: 'outside', description: null, source: 'tools', enabled: null, detail: 'v1' },
    ]);
    expect(byKind('mcp')).toEqual([
      { kind: 'mcp', name: 'fmtd', description: 'stdio 서버', source: 'fmt', enabled: true, detail: 'fmtd' },
    ]);
    expect(byKind('skill').map((i) => i.name)).toEqual(['deploy']);
    expect(byKind('agent')).toEqual([{ kind: 'agent', name: 'reviewer', description: 'Reviews diffs', source: '사용자', enabled: null }]);
    expect(byKind('output-style').map((i) => i.name)).toEqual(['terse']);
    expect(byKind('hook').map((i) => i.name)).toEqual(['Stop', 'notify.sh']);
    expect(inv.problems).toEqual([{ path: join('skills', 'broken', 'SKILL.md'), message: 'frontmatter가 없습니다' }]);
  });

  it('a corrupt installed_plugins.json / settings.json is reported, the rest still lists', async () => {
    write('plugins/installed_plugins.json', '{"version": 2, "plugins": {');
    write('settings.json', 'nope');
    write('agents/a.md', '---\nname: a\n---\n');
    const inv = await readPluginInventory(root);
    expect(inv.items.map((i) => i.name)).toEqual(['a']);
    expect(inv.problems.map((p) => p.path).sort()).toEqual([join('plugins', 'installed_plugins.json'), 'settings.json']);
    expect(inv.problems.every((p) => p.message.startsWith('JSON을 읽을 수 없습니다'))).toBe(true);
  });
});
