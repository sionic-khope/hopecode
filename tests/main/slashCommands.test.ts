import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FALLBACK_BUILTINS,
  bodyPreview,
  commandFromFile,
  createSlashCommandService,
  mergeSlashCommands,
  readContained,
  scanSlashCommands,
  splitFrontmatter,
} from '../../src/main/commands/slashCommands';

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const skill = (name: string, extra = '', body = 'Body line') => `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n\n${body}\n`;

describe('frontmatter', () => {
  it('splits frontmatter and body; block scalars and quotes are flattened', () => {
    const { meta, body } = splitFrontmatter('---\nname: demo\ndescription: >\n  first\n  second\nargument-hint: "<file>"\n---\n# Title\ntext\n');
    expect(meta).toEqual({ name: 'demo', description: 'first second', 'argument-hint': '<file>' });
    expect(body).toBe('# Title\ntext\n');
  });

  it('no frontmatter (or an unterminated one) keeps the whole text as body', () => {
    expect(splitFrontmatter('# Just text\n')).toEqual({ meta: null, body: '# Just text\n' });
    expect(splitFrontmatter('---\nname: x\nno end').meta).toBeNull();
    expect(splitFrontmatter('﻿---\nname: bom\n---\nb').meta).toEqual({ name: 'bom' });
  });

  it('preview: leading blank lines dropped, 40 lines max', () => {
    const body = `\n\n${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}`;
    const preview = bodyPreview(body);
    expect(preview.split('\n')).toHaveLength(40);
    expect(preview.startsWith('line 0')).toBe(true);
  });

  it('commandFromFile: argument-hint, command description fallback, user-invocable: false', () => {
    const info = { name: 'x', source: 'user' as const, kind: 'command' as const, path: '/p' };
    expect(commandFromFile('---\nargument-hint: <pr>\n---\n# Review the PR\nmore', info)).toMatchObject({
      description: 'Review the PR',
      argumentHint: '<pr>',
      preview: '# Review the PR\nmore',
    });
    expect(commandFromFile('---\ndescription: d\n---\nb', { ...info, kind: 'skill' })!.argumentHint).toBeNull();
    expect(commandFromFile('---\nuser-invocable: false\n---\nb', info)).toBeNull();
  });
});

describe('scanSlashCommands', () => {
  let root: string;
  let user: string;
  let project: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hc-slash-'));
    user = join(root, 'claude');
    project = join(root, 'project');
    outside = join(root, 'outside');
    mkdirSync(user, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists user skills, nested commands, project entries and enabled plugins', async () => {
    write(join(user, 'skills', 'demo', 'SKILL.md'), skill('demo', 'argument-hint: <topic>\n'));
    write(join(user, 'commands', 'deploy.md'), '---\ndescription: Deploy\n---\nrun');
    write(join(user, 'commands', 'git', 'pr.md'), 'Open a PR\n');
    write(join(project, '.claude', 'skills', 'local', 'SKILL.md'), skill('local'));
    write(join(project, '.claude', 'commands', 'lint.md'), '---\ndescription: Lint\n---\n');
    const pluginDir = join(user, 'plugins', 'cache', 'mk', 'tools', '1.0.0');
    write(join(pluginDir, 'skills', 'fmt', 'SKILL.md'), skill('fmt'));
    write(join(pluginDir, 'commands', 'ship.md'), '---\ndescription: Ship\n---\n');
    const offDir = join(user, 'plugins', 'cache', 'mk', 'off', '1.0.0');
    write(join(offDir, 'skills', 'hidden', 'SKILL.md'), skill('hidden'));
    write(
      join(user, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'tools@mk': [{ installPath: pluginDir, version: '1.0.0' }], 'off@mk': [{ installPath: offDir }] },
      }),
    );
    write(join(user, 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@mk': true, 'off@mk': false } }));

    const rows = await scanSlashCommands({ userDir: user, projectDir: project });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(rows.map((r) => r.name)).toEqual(['local', 'lint', 'demo', 'deploy', 'git:pr', 'tools:fmt', 'tools:ship']);
    expect(by['demo']).toMatchObject({ source: 'user', kind: 'skill', argumentHint: '<topic>', description: 'demo skill', preview: 'Body line' });
    expect(by['demo']!.path).toBe(join(user, 'skills', 'demo', 'SKILL.md'));
    expect(by['git:pr']).toMatchObject({ kind: 'command', description: 'Open a PR' });
    expect(by['local']!.source).toBe('project');
    expect(by['tools:fmt']).toMatchObject({ source: 'plugin', plugin: 'tools' });
  });

  it('refuses a symlink that escapes the root (skill folder, command file, command folder)', async () => {
    write(join(outside, 'evil', 'SKILL.md'), skill('evil'));
    write(join(outside, 'secret.md'), '---\ndescription: secret\n---\n');
    write(join(outside, 'sub', 'x.md'), '---\ndescription: x\n---\n');
    mkdirSync(join(user, 'skills'), { recursive: true });
    mkdirSync(join(user, 'commands'), { recursive: true });
    symlinkSync(join(outside, 'evil'), join(user, 'skills', 'evil'));
    symlinkSync(join(outside, 'secret.md'), join(user, 'commands', 'secret.md'));
    symlinkSync(join(outside, 'sub'), join(user, 'commands', 'sub'));
    // A link that stays inside the root is fine.
    write(join(user, 'skill-src', 'inner', 'SKILL.md'), skill('inner'));
    symlinkSync(join(user, 'skill-src', 'inner'), join(user, 'skills', 'inner'));

    const rows = await scanSlashCommands({ userDir: user });
    expect(rows.map((r) => r.name)).toEqual(['inner']);
  });

  it('extraRoots admits links into ~/.agents/skills only for user skills', async () => {
    const agents = join(root, '.agents', 'skills');
    write(join(agents, 'shared', 'SKILL.md'), skill('shared'));
    mkdirSync(join(user, 'skills'), { recursive: true });
    symlinkSync(join(agents, 'shared'), join(user, 'skills', 'shared'));
    expect((await scanSlashCommands({ userDir: user })).map((r) => r.name)).toEqual([]);
    expect((await scanSlashCommands({ userDir: user, extraRoots: [agents] })).map((r) => r.name)).toEqual(['shared']);
  });

  it('a plugin installPath outside the config folder (path traversal) is never read', async () => {
    write(join(outside, 'plug', 'skills', 'esc', 'SKILL.md'), skill('esc'));
    write(
      join(user, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'esc@mk': { installPath: join(user, 'plugins', '..', '..', 'outside', 'plug') } } }),
    );
    expect(await scanSlashCommands({ userDir: user })).toEqual([]);
  });

  it('skips files over the size cap and stops at the file budget', async () => {
    write(join(user, 'skills', 'big', 'SKILL.md'), skill('big', '', 'x'.repeat(2048)));
    write(join(user, 'skills', 'small', 'SKILL.md'), skill('small'));
    expect((await scanSlashCommands({ userDir: user, maxFileBytes: 1024 })).map((r) => r.name)).toEqual(['small']);
    for (let i = 0; i < 5; i++) write(join(user, 'commands', `c${i}.md`), 'cmd');
    expect(await scanSlashCommands({ userDir: user, maxFiles: 3 })).toHaveLength(3);
  });

  it('readContained refuses paths outside the roots and non-files', async () => {
    write(join(user, 'a.md'), 'ok');
    write(join(outside, 'b.md'), 'no');
    const roots = [realpathSync(user)];
    expect(await readContained(join(user, 'a.md'), roots, 100)).toBe('ok');
    expect(await readContained(join(user, 'a.md'), roots, 1)).toBeNull();
    expect(await readContained(join(user, '..', 'outside', 'b.md'), roots, 100)).toBeNull();
    expect(await readContained(join(user, 'missing.md'), roots, 100)).toBeNull();
    expect(await readContained(user, roots, 100)).toBeNull();
  });

  it('a missing config folder yields nothing', async () => {
    expect(await scanSlashCommands({ userDir: join(root, 'nope'), projectDir: join(root, 'nope2') })).toEqual([]);
  });
});

describe('mergeSlashCommands', () => {
  const scanned = [
    { name: 'demo', description: '', argumentHint: null, source: 'user' as const, kind: 'skill' as const, path: '/d', preview: 'p' },
  ];

  it('without a live list: scanned rows + the fallback built-ins', () => {
    const list = mergeSlashCommands(scanned, null);
    expect(list.origin).toBe('scan');
    expect(list.commands.map((c) => c.name)).toEqual(['demo', ...FALLBACK_BUILTINS.map((b) => b.name)]);
  });

  it('live list: GUI built-ins only, enriches scanned rows, adds session-only rows', () => {
    const list = mergeSlashCommands(scanned, [
      { name: 'demo', description: 'from sdk', argumentHint: '<x>' },
      { name: 'compact', description: 'Compact', argumentHint: '', builtin: true },
      { name: 'exit', description: 'Exit', argumentHint: '', builtin: true },
      { name: 'mcp__srv__prompt', description: 'MCP prompt', argumentHint: '' },
    ]);
    expect(list.origin).toBe('session');
    expect(list.commands.map((c) => [c.name, c.source])).toEqual([
      ['demo', 'user'],
      ['mcp__srv__prompt', 'session'],
      ['compact', 'builtin'],
    ]);
    expect(list.commands[0]).toMatchObject({ description: 'from sdk', argumentHint: '<x>', preview: 'p' });
    expect(list.commands[2]!.argumentHint).toBeNull();
  });

  it('service: live list with a timeout-safe fallback, scan of the user folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-slash-svc-'));
    try {
      write(join(dir, 'skills', 'demo', 'SKILL.md'), skill('demo'));
      const svc = createSlashCommandService({
        userDir: dir,
        live: (id) => (id === 't1' ? Promise.resolve([{ name: 'clear', description: 'Clear', argumentHint: '', builtin: true }]) : null),
      });
      expect((await svc.list({ threadId: 't1', projectDir: null })).commands.map((c) => c.name)).toEqual(['demo', 'clear']);
      const draft = await svc.list({ threadId: null, projectDir: null });
      expect(draft.origin).toBe('scan');
      const failing = createSlashCommandService({ userDir: dir, live: () => Promise.reject(new Error('gone')) });
      expect((await failing.list({ threadId: 't1', projectDir: null })).origin).toBe('scan');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
