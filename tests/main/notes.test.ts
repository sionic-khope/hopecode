import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIST_DIR_MAX,
  createEntry,
  isTooBroadVault,
  listDir,
  readNote,
  renameEntry,
  searchNames,
  siblingNotes,
  trashEntry,
  writeNote,
} from '../../src/main/notes/vaultFs';
import { NOTE_GIT_BASE_ARGS, NOTE_GIT_TIMEOUT_MS, createNoteGit, type GitRunner } from '../../src/main/notes/noteGit';
import { MAX_REPORTED, createNoteWatcher } from '../../src/main/notes/noteWatcher';
import { createAcpFixtureLauncher } from '../../src/main/fixtures/acpFixtureLaunchers';
import type { AcpLaunchSpec } from '../../src/main/contracts';
import { createNoteChats } from '../../src/main/notes/noteChats';
import { TOOL_BLOCKED_ERROR, runNoteAi, type NoteAiDeps } from '../../src/main/notes/noteAi';
import { buildNotesHandlers, type NotesServices } from '../../src/main/ipc/notesHandlers';
import { createFakeQuery, createFixtureScenario } from '../../src/main/fixtures/fakeQuery';
import { buildNoteInlinePrompt, buildNoteSystemPrompt } from '../../src/core/notes/notePrompt';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { Account, AppSettings } from '../../src/shared/types';
import type { NoteAiEvent, NoteChange } from '../../src/shared/notes';

let root: string;
let vault: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hopecode-notes-test-')));
  vault = join(root, 'vault');
  mkdirSync(join(vault, 'Back-End'), { recursive: true });
  mkdirSync(join(vault, '.git'), { recursive: true });
  mkdirSync(join(vault, 'node_modules'), { recursive: true });
  writeFileSync(join(vault, 'Back-End', 'distlock.md'), '# Lock\n\nbody\n');
  writeFileSync(join(vault, 'Back-End', 'cache.md'), '# Cache\n');
  writeFileSync(join(vault, 'Back-End', 'image.png'), 'x');
  writeFileSync(join(vault, 'node_modules', 'pkg.md'), 'x');
  writeFileSync(join(root, 'outside.md'), 'secret');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('vaultFs containment', () => {
  it('refuses .., absolute paths, hidden folders and symlinks that leave the vault', async () => {
    symlinkSync(join(root, 'outside.md'), join(vault, 'escape.md'));
    symlinkSync(root, join(vault, 'escapedir'));
    await expect(readNote(vault, '../outside.md')).rejects.toThrow();
    await expect(readNote(vault, `${root}/outside.md`)).rejects.toThrow();
    await expect(readNote(vault, '.git/config.md')).rejects.toThrow();
    await expect(readNote(vault, 'escape.md')).rejects.toThrow(/노트 폴더 밖/);
    await expect(writeNote(vault, 'escapedir/new.md', 'x')).rejects.toThrow(/노트 폴더 밖/);
    await expect(writeNote(vault, 'escape.md', 'x')).rejects.toThrow();
    expect(readFileSync(join(root, 'outside.md'), 'utf8')).toBe('secret');
    // Links that leave the vault are not even listed.
    expect((await listDir(vault, '')).entries.map((e) => e.name)).toEqual(['Back-End']);
  });

  it('lists folders and .md files only, hidden folders left out, folders first', async () => {
    mkdirSync(join(vault, 'Back-End', 'Sub'));
    const listing = await listDir(vault, 'Back-End');
    expect(listing.entries.map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:Back-End/Sub', 'file:Back-End/cache.md', 'file:Back-End/distlock.md']);
    expect((await listDir(vault, '')).entries.map((e) => e.name)).toEqual(['Back-End']);
  });

  it('name search skips hidden folders', async () => {
    expect((await searchNames(vault, 'LOCK')).paths).toEqual(['Back-End/distlock.md']);
    expect((await searchNames(vault, 'pkg')).paths).toEqual([]);
  });
});

describe('vaultFs writes', () => {
  it('writes atomically (no temp file left), .md only, 2 MB max', async () => {
    await writeNote(vault, 'Back-End/distlock.md', '# New\n');
    expect(readFileSync(join(vault, 'Back-End', 'distlock.md'), 'utf8')).toBe('# New\n');
    expect(readdirSync(join(vault, 'Back-End')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    await writeNote(vault, 'Back-End/fresh.md', 'x');
    expect(existsSync(join(vault, 'Back-End', 'fresh.md'))).toBe(true);
    await expect(writeNote(vault, 'Back-End/a.txt', 'x')).rejects.toThrow(/\.md/);
    await expect(writeNote(vault, 'Back-End/big.md', 'x'.repeat(2 * 1024 * 1024 + 1))).rejects.toThrow(/2 MB/);
    await expect(writeNote(vault, 'Missing/x.md', 'x')).rejects.toThrow();
  });

  it('creates (adding .md), renames inside the folder and trashes through the injected seam', async () => {
    expect(await createEntry(vault, 'Back-End/redis', 'file')).toEqual({ name: 'redis.md', path: 'Back-End/redis.md', kind: 'file' });
    await expect(createEntry(vault, 'Back-End/redis.md', 'file')).rejects.toThrow(/이미/);
    expect((await createEntry(vault, 'Network', 'dir')).kind).toBe('dir');
    expect(await renameEntry(vault, 'Back-End/redis.md', 'redlock')).toEqual({ name: 'redlock.md', path: 'Back-End/redlock.md', kind: 'file' });
    await expect(renameEntry(vault, 'Back-End/redlock.md', '../x')).rejects.toThrow();
    const trash = vi.fn(async () => {});
    await trashEntry(vault, 'Back-End/redlock.md', trash);
    expect(trash).toHaveBeenCalledWith(join(vault, 'Back-End', 'redlock.md'));
    await expect(trashEntry(vault, '', trash)).rejects.toThrow();
  });

  it('style references come from the same folder, never the note itself', async () => {
    const refs = await siblingNotes(vault, 'Back-End/distlock.md', 2);
    expect(refs.map((r) => r.path)).toEqual(['Back-End/cache.md']);
  });
});

describe('noteGit', () => {
  it('commits only the changed .md files of the vault and never pushes', async () => {
    const g = (...args: string[]) => execFileSync('git', args, { cwd: vault, encoding: 'utf8' });
    rmSync(join(vault, '.git'), { recursive: true });
    g('init', '-q');
    g('config', 'user.name', 'T');
    g('config', 'user.email', 't@example.com');
    g('config', 'commit.gpgsign', 'false');
    g('add', 'Back-End/distlock.md');
    g('commit', '-q', '-m', 'init');
    writeFileSync(join(vault, 'Back-End', 'distlock.md'), '# changed\n');
    writeFileSync(join(vault, 'other.txt'), 'not a note');
    const noteGit = createNoteGit(() => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }));
    const status = await noteGit.status(vault);
    expect(status.isRepo).toBe(true);
    expect(status.changed.sort()).toEqual(['Back-End/cache.md', 'Back-End/distlock.md']);
    const res = await noteGit.commit(vault, 'notes');
    expect(res).toMatchObject({ ok: true, files: 2 });
    expect(g('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['Back-End/cache.md', 'Back-End/distlock.md']);
    expect(g('status', '--porcelain')).toContain('other.txt');
    expect((await noteGit.status(vault)).changed).toEqual([]);
    expect(await noteGit.commit(vault, 'again')).toMatchObject({ ok: false });
  });

  it('a plain folder is not a repo', async () => {
    rmSync(join(vault, '.git'), { recursive: true });
    const noteGit = createNoteGit(() => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CEILING_DIRECTORIES: root }));
    expect(await noteGit.status(vault)).toEqual({ isRepo: false, changed: [] });
  });
});

const ACCOUNT: Account = { id: 'a1', alias: 'A', color: '#000', email: null, plan: 'max', configDir: '/tmp/a1', priority: 0, enabled: true, createdAt: 0 };

function aiDeps(query: NoteAiDeps['query']): NoteAiDeps {
  return {
    query,
    listAccounts: () => [ACCOUNT],
    usage: { getSnapshot: () => ({ usageById: {} }) as never },
    shellEnv: { childEnv: (inject) => ({ CLAUDE_CONFIG_DIR: inject.configDir ?? '' }) },
    claudeBinary: { resolvePath: () => 'claude' },
    appVersion: '0.0.0',
    codexLauncher: { resolve: () => ({ ok: false, reason: 'not-installed' }) },
    codexUsable: () => false,
    codexMcpServers: () => [],
    runDir: join(root, 'run'),
    now: Date.now,
    log: () => {},
  };
}

describe('runNoteAi (Claude)', () => {
  it('runs a tool-less single turn and streams the text', async () => {
    const fake = createFakeQuery({ scenario: createFixtureScenario() });
    const deltas: string[] = [];
    const res = await runNoteAi(
      aiDeps(fake.query),
      { agent: 'claude-code', model: 'opus', effort: 'high', system: buildNoteSystemPrompt(), prompt: '## 작업 (대화)\n\n## 요청\n전체 정리' },
      (t) => deltas.push(t),
      new AbortController().signal,
    );
    expect(res).toEqual({ ok: true, stopped: false });
    expect(deltas.join('')).toContain('FIXTURE-REWRITE: 전체 정리');
    const opts = fake.calls[0].options;
    expect(opts.tools).toEqual([]);
    expect(opts.maxTurns).toBe(1);
    expect(opts.persistSession).toBe(false);
    expect(opts.settingSources).toEqual([]);
    // No MCP server reaches a note request: none passed, none loaded from user / project config.
    expect(opts.mcpServers).toEqual({});
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.model).toBe('opus');
    expect(await opts.canUseTool!('Write', {}, { signal: new AbortController().signal, toolUseID: 't' } as never)).toMatchObject({ behavior: 'deny' });
  });

  it('a stop keeps what streamed so far and reports stopped', async () => {
    const fake = createFakeQuery({ scenario: createFixtureScenario() });
    const abort = new AbortController();
    const deltas: string[] = [];
    const res = await runNoteAi(
      aiDeps(fake.query),
      { agent: 'claude-code', model: null, effort: null, system: buildNoteSystemPrompt(), prompt: '## 요청\n주제 [slow]\n' },
      (t) => {
        deltas.push(t);
        abort.abort();
      },
      abort.signal,
    );
    expect(res).toEqual({ ok: true, stopped: true });
    expect(deltas).toHaveLength(1);
  });

  it('Codex unavailable / no account are errors, not throws', async () => {
    const fake = createFakeQuery();
    const deps = { ...aiDeps(fake.query), listAccounts: () => [] };
    expect(await runNoteAi(deps, { agent: 'claude-code', model: null, effort: null, system: 's', prompt: 'p' }, () => {}, new AbortController().signal)).toMatchObject({ ok: false });
    expect(await runNoteAi(deps, { agent: 'codex', model: null, effort: null, system: 's', prompt: 'p' }, () => {}, new AbortController().signal)).toMatchObject({ ok: false });
  });
});

describe('notes handlers', () => {
  function setup(git: NotesServices['git'] = createNoteGit(() => ({}))) {
    let settings: AppSettings = { ...DEFAULT_SETTINGS };
    const store = {
      get: () => ({ settings }) as never,
      update: (fn: (d: { settings: AppSettings }) => void) => {
        const draft = { settings: { ...settings } };
        fn(draft);
        settings = draft.settings;
      },
    };
    const events: NoteAiEvent[] = [];
    const broadcaster = { emit: (ch: string, payload: unknown) => ch === 'notes:ai' && events.push(payload as NoteAiEvent) };
    const runAi = vi.fn<NotesServices['runAi']>(async (_run, onDelta) => {
      onDelta('# 새 노트\n');
      return { ok: true, stopped: false };
    });
    const services: NotesServices = {
      pickFolder: async () => vault,
      trash: async () => {},
      openExternal: () => true,
      git,
      chats: createNoteChats(join(root, 'chats')),
      watcher: { set: () => {}, dispose: () => {} },
      runAi,
    };
    const h = buildNotesHandlers(store as never, broadcaster as never, services);
    return { h, events, runAi, settings: () => settings };
  }

  it('requires a vault, registers one through the picker and validates paths', async () => {
    const { h, settings } = setup();
    await expect(h['notes:listDir']({ dir: '' })).rejects.toThrow(/노트 폴더/);
    await h['notes:addVault'](undefined);
    expect(settings().noteVaults).toEqual([vault]);
    expect(settings().activeNoteVault).toBe(vault);
    await expect(h['notes:read']({ path: '../outside.md' })).rejects.toThrow(/invalid path/);
    await expect(h['notes:selectVault']({ path: '/elsewhere' })).rejects.toThrow(/unknown vault/);
    await h['notes:removeVault']({ path: vault });
    expect(settings().activeNoteVault).toBe('');
  });

  it('aiStart (chat) builds the prompt with style refs and history, streams events and records the whole answer', async () => {
    const { h, events, runAi } = setup();
    await h['notes:addVault'](undefined);
    const req = {
      requestId: 'r1',
      path: 'Back-End/distlock.md',
      agent: 'claude-code',
      model: null,
      effort: null,
      kind: 'chat',
      request: '분산 락',
      document: '# Lock\n\n### 1. 개념\nbody\n',
      selection: null,
    };
    await expect(h['notes:aiStart']({ ...req, agent: 'hermes' })).rejects.toThrow();
    await expect(h['notes:aiStart']({ ...req, kind: 'write' })).rejects.toThrow(/invalid kind/);
    await expect(h['notes:aiStart']({ ...req, selection: { from: 0, to: 1 } })).rejects.toThrow(/invalid selection/);
    expect(await h['notes:aiStart'](req)).toEqual({ ok: true });
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ requestId: 'r1', type: 'done', stopped: false }));
    expect(events[0]).toEqual({ requestId: 'r1', type: 'delta', text: '# 새 노트\n' });
    const run = runAi.mock.calls[0][0];
    expect(run.prompt).toContain('<reference path="Back-End/cache.md">');
    expect(run.prompt).toContain('## 작업 (대화)');
    expect(run.prompt).toContain('- ### 1. 개념');
    expect(run.system).toContain('좋은 질문입니다');
    let chat = await h['notes:chat']({ path: 'Back-End/distlock.md' });
    expect(chat.map((c) => [c.role, c.text, c.status])).toEqual([
      ['user', '분산 락', undefined],
      ['assistant', '# 새 노트\n', 'done'],
    ]);
    // The next turn carries the conversation so far.
    expect(await h['notes:aiStart']({ ...req, requestId: 'r2', request: '더' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ requestId: 'r2', type: 'done' }));
    expect(runAi.mock.calls[1][0].prompt).toContain('## 이전 대화\n<user>\n분산 락\n</user>\n<assistant>\n# 새 노트\n</assistant>');

    // Card marks are kept with the answer; bad marks are refused.
    const answer = chat[1];
    const mark = { state: 'applied', at: 3, inserted: 'x', original: '' };
    expect(await h['notes:chatCard']({ path: 'Back-End/distlock.md', itemId: answer.id, card: 0, mark })).toBe(true);
    expect(await h['notes:chatCard']({ path: 'Back-End/distlock.md', itemId: 'gone', card: 0, mark })).toBe(false);
    await expect(h['notes:chatCard']({ path: 'Back-End/distlock.md', itemId: answer.id, card: 0, mark: { state: 'eaten' } })).rejects.toThrow(/invalid mark/);
    await expect(h['notes:chatCard']({ path: '../x.md', itemId: answer.id, card: 0, mark })).rejects.toThrow(/invalid path/);
    chat = await h['notes:chat']({ path: 'Back-End/distlock.md' });
    expect(chat[1].cards).toEqual({ '0': mark });
    await h['notes:chatCard']({ path: 'Back-End/distlock.md', itemId: answer.id, card: 0, mark: { state: 'reverted', at: 1 } });
    expect((await h['notes:chat']({ path: 'Back-End/distlock.md' }))[1].cards).toEqual({ '0': { state: 'reverted' } });
    // Nothing was written into the vault by the requests.
    expect(readFileSync(join(vault, 'Back-End', 'distlock.md'), 'utf8')).toBe('# Lock\n\nbody\n');
  });

  it('aiStart (inline) sends the selection and keeps it out of the conversation; a failed chat turn keeps only its error', async () => {
    const { h, events, runAi } = setup();
    await h['notes:addVault'](undefined);
    const doc = '# Lock\n\n첫 문장이다. 둘째 문장이다.\n';
    const from = doc.indexOf('둘째');
    const req = { requestId: 'i1', path: 'Back-End/distlock.md', agent: 'codex', model: null, effort: null, kind: 'inline', request: '짧게', document: doc };
    await expect(h['notes:aiStart']({ ...req, selection: null })).rejects.toThrow(/selection required/);
    await expect(h['notes:aiStart']({ ...req, selection: { from: 5, to: 2 } })).rejects.toThrow(/invalid selection/);
    await expect(h['notes:aiStart']({ ...req, selection: { from: 0, to: doc.length + 1 } })).rejects.toThrow(/invalid selection/);
    expect(await h['notes:aiStart']({ ...req, selection: { from: 6, to: 8 } })).toEqual({ ok: false, error: '고칠 부분이 비어 있습니다' });
    expect(await h['notes:aiStart']({ ...req, selection: { from, to: doc.length - 1 } })).toEqual({ ok: true });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ requestId: 'i1', type: 'done' }));
    expect(runAi.mock.calls[0][0].prompt).toContain('<selection>\n둘째 문장이다.\n</selection>');
    expect(runAi.mock.calls[0][0].agent).toBe('codex');
    expect(await h['notes:chat']({ path: 'Back-End/distlock.md' })).toEqual([]);

    runAi.mockImplementationOnce(async (_run, onDelta) => {
      onDelta('반쯤 쓴 답');
      return { ok: false, stopped: false, error: '도구를 쓰려고 해서 중단' };
    });
    expect(await h['notes:aiStart']({ ...req, requestId: 'c1', kind: 'chat', selection: null })).toEqual({ ok: true });
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ requestId: 'c1', type: 'error', message: '도구를 쓰려고 해서 중단' }));
    const chat = await h['notes:chat']({ path: 'Back-End/distlock.md' });
    expect(chat.map((c) => [c.role, c.text, c.status])).toEqual([
      ['user', '짧게', undefined],
      ['assistant', '도구를 쓰려고 해서 중단', 'error'],
    ]);
  });
});

describe('runNoteAi (Codex, fake ACP agent)', () => {
  const FAKE_AGENT = resolve(__dirname, '../fixtures/acp/fakeAcpAgent.mjs');

  function codexDeps() {
    const stateDir = join(root, 'state');
    const inner = createAcpFixtureLauncher({ profile: 'codex', scriptPath: FAKE_AGENT, stateDir });
    const specs: AcpLaunchSpec[] = [];
    const deps: NoteAiDeps = {
      ...aiDeps(createFakeQuery().query),
      codexUsable: () => true,
      codexMcpServers: () => ['docs', 'bad name'],
      codexLauncher: {
        async resolve(cwd, opts) {
          const res = await inner.resolve(cwd, opts);
          if (res.ok) specs.push(res.spec);
          return res;
        },
      },
    };
    return { deps, specs, stateDir };
  }

  it('runs read-only with every tool family Codex can switch off disabled in CODEX_CONFIG', async () => {
    const { deps, specs } = codexDeps();
    const deltas: string[] = [];
    const res = await runNoteAi(deps, { agent: 'codex', model: null, effort: null, system: buildNoteSystemPrompt(), prompt: '## 작업 (대화)\n\n## 요청\n전체 정리' }, (t) => deltas.push(t), new AbortController().signal);
    expect(res).toEqual({ ok: true, stopped: false });
    expect(deltas.join('')).toContain('CODEX-REWRITE: 전체 정리');
    const env = specs[0].env;
    expect(env.INITIAL_AGENT_MODE).toBe('read-only');
    const config = JSON.parse(env.CODEX_CONFIG) as { web_search: string; features: Record<string, boolean>; mcp_servers: Record<string, unknown> };
    expect(config.web_search).toBe('disabled');
    for (const key of ['shell_tool', 'unified_exec', 'apply_patch_freeform', 'view_image', 'web_search_request', 'web_search_cached', 'standalone_web_search', 'apps', 'plugins']) {
      expect(config.features[key]).toBe(false);
    }
    // Only valid server names reach the config.
    expect(config.mcp_servers).toEqual({ docs: { enabled: false } });
  });

  it('a tool call cancels the turn, drops what followed and ends in an error', async () => {
    const { deps, stateDir } = codexDeps();
    const deltas: string[] = [];
    const res = await runNoteAi(
      deps,
      { agent: 'codex', model: null, effort: null, system: buildNoteSystemPrompt(), prompt: '## 작업 (대화)\n\n## 요청\n[tool] 전체 정리' },
      (t) => deltas.push(t),
      new AbortController().signal,
    );
    expect(res).toEqual({ ok: false, stopped: false, error: TOOL_BLOCKED_ERROR });
    // Text before the tool call streamed (the renderer rolls it back on the error); nothing after it did.
    expect(deltas.join('')).not.toContain('FAKE-SECRET-KEY');
    await vi.waitFor(() => expect(readdirSync(stateDir).some((f) => f.endsWith('.cancelled'))).toBe(true));
  });
});

describe('noteGit hardening', () => {
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const env = () => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' });

  function initRepo(dir: string) {
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    g(dir, 'init', '-q');
    g(dir, 'config', 'user.name', 'T');
    g(dir, 'config', 'user.email', 't@example.com');
    g(dir, 'config', 'commit.gpgsign', 'false');
  }

  it('every call carries the common options and a timeout; status / rev-parse skip hooks, commit keeps them', async () => {
    initRepo(vault);
    g(vault, 'add', 'Back-End/distlock.md');
    g(vault, 'commit', '-q', '-m', 'init');
    writeFileSync(join(vault, 'Back-End', 'distlock.md'), '# changed\n');
    const calls: { args: string[]; timeout?: number }[] = [];
    const exec: GitRunner = async (cmd, args, cwd, e, timeout) => {
      calls.push({ args, timeout });
      const { run } = await import('../../src/main/git/gitService');
      return run(cmd, args, cwd, e, timeout);
    };
    const noteGit = createNoteGit(env, exec);
    await noteGit.status(vault);
    expect(await noteGit.commit(vault, 'notes')).toMatchObject({ ok: true });
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) {
      expect(c.args.slice(0, NOTE_GIT_BASE_ARGS.length)).toEqual([...NOTE_GIT_BASE_ARGS]);
      expect(c.timeout).toBe(NOTE_GIT_TIMEOUT_MS);
    }
    const sub = (c: { args: string[] }) => c.args.find((a) => ['status', 'rev-parse', 'config', 'add', 'commit'].includes(a));
    for (const c of calls) {
      const hooksOff = c.args.includes('core.hooksPath=/dev/null');
      expect(hooksOff).toBe(['status', 'rev-parse', 'config'].includes(sub(c) ?? ''));
    }
  });

  it('status never runs a filter driver from the repository config', async () => {
    initRepo(vault);
    g(vault, 'add', 'Back-End/distlock.md');
    g(vault, 'commit', '-q', '-m', 'init');
    writeFileSync(join(vault, '.gitattributes'), '*.md filter=evil\n');
    const marker = join(root, 'filter-ran');
    g(vault, 'config', 'filter.evil.clean', `touch ${marker}; cat`);
    g(vault, 'config', 'filter.evil.required', 'true');
    const later = new Date(Date.now() + 5_000);
    const touchNote = () => utimesSync(join(vault, 'Back-End', 'distlock.md'), later, later);
    touchNote();
    const status = await createNoteGit(env).status(vault);
    expect(status.isRepo).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // Sanity: a plain status does run it.
    touchNote();
    g(vault, 'status', '--porcelain');
    expect(existsSync(marker)).toBe(true);
  });

  it('a repository above the vault, a linked or gitfile .git turn git off (no git process)', async () => {
    rmSync(join(vault, '.git'), { recursive: true });
    initRepo(root);
    const exec = vi.fn<GitRunner>(async () => ({ ok: true, code: 0, stdout: `${root}\n`, stderr: '' }));
    const noteGit = createNoteGit(env, exec);
    expect(await noteGit.status(vault)).toEqual({ isRepo: false, changed: [] });
    expect(await noteGit.detect(vault)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    // A .git link (to the parent's) and a gitfile are refused as well.
    symlinkSync(join(root, '.git'), join(vault, '.git'));
    expect(await noteGit.detect(vault)).toBe(false);
    rmSync(join(vault, '.git'));
    writeFileSync(join(vault, '.git'), `gitdir: ${join(root, '.git')}\n`);
    expect(await noteGit.detect(vault)).toBe(false);
    expect(await noteGit.status(vault)).toEqual({ isRepo: false, changed: [] });
    expect(exec).not.toHaveBeenCalled();
  });

  it('a top level other than the vault turns git off', async () => {
    const exec = vi.fn<GitRunner>(async () => ({ ok: true, code: 0, stdout: `${root}\n`, stderr: '' }));
    const noteGit = createNoteGit(env, exec);
    // beforeEach made vault/.git an (owned) folder: rev-parse runs and reports the parent.
    expect(await noteGit.detect(vault)).toBe(true);
    expect(await noteGit.status(vault)).toEqual({ isRepo: false, changed: [] });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('commits a file named *.md literally (no glob over other notes)', async () => {
    initRepo(vault);
    mkdirSync(join(vault, 'node_modules'), { recursive: true });
    writeFileSync(join(vault, 'node_modules', 'pkg.md'), 'v1\n');
    g(vault, 'add', '-f', 'node_modules/pkg.md', 'Back-End/distlock.md', 'Back-End/cache.md');
    g(vault, 'commit', '-q', '-m', 'init');
    writeFileSync(join(vault, '*.md'), '# star\n');
    writeFileSync(join(vault, 'node_modules', 'pkg.md'), 'v2\n');
    const res = await createNoteGit(env).commit(vault, 'star');
    expect(res).toMatchObject({ ok: true, files: 1 });
    expect(g(vault, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('*.md');
    expect(g(vault, 'status', '--porcelain')).toContain('node_modules/pkg.md');
  });
});

describe('notes handlers: git opt-in', () => {
  function fakeGit() {
    return {
      detect: vi.fn(async () => true),
      status: vi.fn(async () => ({ isRepo: true, changed: ['a.md'] })),
      commit: vi.fn(async () => ({ ok: true as const, sha: 'abc', files: 1 })),
    };
  }

  function make(git: ReturnType<typeof fakeGit>) {
    let settings: AppSettings = { ...DEFAULT_SETTINGS };
    const store = {
      get: () => ({ settings }) as never,
      update: (fn: (d: { settings: AppSettings }) => void) => {
        const draft = { settings: { ...settings } };
        fn(draft);
        settings = draft.settings;
      },
    };
    const services: NotesServices = {
      pickFolder: async () => vault,
      trash: async () => {},
      openExternal: () => true,
      git,
      chats: createNoteChats(join(root, 'chats')),
      watcher: { set: () => {}, dispose: () => {} },
      runAi: async () => ({ ok: true, stopped: false }),
    };
    return { h: buildNotesHandlers(store as never, { emit: () => {} } as never, services), settings: () => settings };
  }

  it('runs no git status before the user turned git on; commit is refused until then', async () => {
    const git = fakeGit();
    const { h, settings } = make(git);
    await h['notes:addVault'](undefined);
    expect(await h['notes:gitStatus'](undefined)).toEqual({ isRepo: true, enabled: false, changed: [] });
    expect(git.status).not.toHaveBeenCalled();
    await expect(h['notes:commit']({ message: 'm' })).rejects.toThrow(/git 기능/);
    expect(git.commit).not.toHaveBeenCalled();
    await h['notes:enableGit'](undefined);
    expect(settings().noteGitVaults).toEqual([vault]);
    expect(await h['notes:gitStatus'](undefined)).toEqual({ isRepo: true, enabled: true, changed: ['a.md'] });
    expect(await h['notes:commit']({ message: 'm' })).toMatchObject({ ok: true });
    // Removing the vault drops its opt-in.
    await h['notes:removeVault']({ path: vault });
    expect(settings().noteGitVaults).toEqual([]);
  });

  it('refuses the home folder and other top-level folders as a vault', async () => {
    expect(await isTooBroadVault('/')).toBe(true);
    expect(await isTooBroadVault('/Users')).toBe(true);
    expect(await isTooBroadVault('/Volumes')).toBe(true);
    expect(await isTooBroadVault('/Volumes/Disk')).toBe(true);
    const home = realpathSync(homedir());
    expect(await isTooBroadVault(home)).toBe(true);
    expect(await isTooBroadVault(dirname(home))).toBe(true);
    expect(await isTooBroadVault(vault)).toBe(false);
    expect(await isTooBroadVault(join(home, 'notes'))).toBe(false);
    const git = fakeGit();
    let settings: AppSettings = { ...DEFAULT_SETTINGS };
    const store = { get: () => ({ settings }) as never, update: (fn: (d: { settings: AppSettings }) => void) => { const d = { settings: { ...settings } }; fn(d); settings = d.settings; } };
    const h = buildNotesHandlers(store as never, { emit: () => {} } as never, {
      pickFolder: async () => homedir(),
      trash: async () => {},
      openExternal: () => true,
      git,
      chats: createNoteChats(join(root, 'chats')),
      watcher: { set: () => {}, dispose: () => {} },
      runAi: async () => ({ ok: true, stopped: false }),
    });
    await expect(h['notes:addVault'](undefined)).rejects.toThrow(/홈 폴더/);
    expect(settings.noteVaults).toEqual([]);
  });
});

describe('vaultFs hardening', () => {
  it('a .md name that resolves to another kind of file is neither read nor written', async () => {
    writeFileSync(join(vault, 'secret.txt'), 'secret');
    symlinkSync(join(vault, 'secret.txt'), join(vault, 'note.md'));
    await expect(readNote(vault, 'note.md')).rejects.toThrow(/\.md/);
    await expect(writeNote(vault, 'note.md', 'x')).rejects.toThrow(/\.md/);
    expect(readFileSync(join(vault, 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('refuses to write a hard-linked note', async () => {
    linkSync(join(vault, 'Back-End', 'cache.md'), join(vault, 'Back-End', 'hard.md'));
    await expect(writeNote(vault, 'Back-End/hard.md', 'x')).rejects.toThrow(/하드 링크/);
    expect(readFileSync(join(vault, 'Back-End', 'cache.md'), 'utf8')).toBe('# Cache\n');
  });

  it('rename never replaces an existing note and keeps the file itself', async () => {
    await expect(renameEntry(vault, 'Back-End/cache.md', 'distlock')).rejects.toThrow(/이미/);
    expect(readFileSync(join(vault, 'Back-End', 'distlock.md'), 'utf8')).toBe('# Lock\n\nbody\n');
    const ino = lstatSync(join(vault, 'Back-End', 'cache.md')).ino;
    await renameEntry(vault, 'Back-End/cache.md', 'cache2');
    expect(existsSync(join(vault, 'Back-End', 'cache.md'))).toBe(false);
    expect(lstatSync(join(vault, 'Back-End', 'cache2.md')).ino).toBe(ino);
    expect(lstatSync(join(vault, 'Back-End', 'cache2.md')).nlink).toBe(1);
  });

  it('rename and trash act on a link itself, not on what it points at', async () => {
    symlinkSync(join(vault, 'Back-End', 'cache.md'), join(vault, 'alias.md'));
    expect(await renameEntry(vault, 'alias.md', 'alias2')).toMatchObject({ path: 'alias2.md', kind: 'file' });
    expect(lstatSync(join(vault, 'alias2.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(vault, 'Back-End', 'cache.md'), 'utf8')).toBe('# Cache\n');
    const trash = vi.fn(async () => {});
    await trashEntry(vault, 'alias2.md', trash);
    expect(trash).toHaveBeenCalledWith(join(vault, 'alias2.md'));
  });

  it('a huge folder is listed up to the cap', async () => {
    mkdirSync(join(vault, 'Big'));
    for (let i = 0; i < LIST_DIR_MAX + 20; i++) writeFileSync(join(vault, 'Big', `n${i}.md`), '');
    const listing = await listDir(vault, 'Big');
    expect(listing.entries).toHaveLength(LIST_DIR_MAX);
    expect(listing.truncated).toBe(true);
  });

  it('an inline selection is clipped in the prompt like the document', () => {
    const prompt = buildNoteInlinePrompt({ request: 'r', notePath: 'a.md', document: 'x'.repeat(500_000), selection: { from: 0, to: 500_000 }, styleRefs: [] });
    expect(prompt.length).toBeLessThan(70_000);
    expect(prompt).toContain('생략');
  });
});

describe('noteWatcher', () => {
  it('a burst over the cap is reported as one full refresh', async () => {
    const changes: NoteChange[] = [];
    const watcher = createNoteWatcher((c) => changes.push(c), () => {});
    watcher.set(vault);
    try {
      await new Promise((r) => setTimeout(r, 100));
      for (let i = 0; i < MAX_REPORTED + 50; i++) writeFileSync(join(vault, `w${i}.md`), 'x');
      await vi.waitFor(() => expect(changes.some((c) => c.all)).toBe(true), { timeout: 5_000 });
      const full = changes.find((c) => c.all) as NoteChange;
      expect(full.paths).toEqual([]);
    } finally {
      watcher.dispose();
    }
  });
});
