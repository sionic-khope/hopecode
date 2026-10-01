import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEntry,
  listDir,
  readNote,
  renameEntry,
  searchNames,
  siblingNotes,
  trashEntry,
  writeNote,
} from '../../src/main/notes/vaultFs';
import { createNoteGit } from '../../src/main/notes/noteGit';
import { createNoteChats } from '../../src/main/notes/noteChats';
import { runNoteAi, type NoteAiDeps } from '../../src/main/notes/noteAi';
import { buildNotesHandlers, type NotesServices } from '../../src/main/ipc/notesHandlers';
import { createFakeQuery, createFixtureScenario } from '../../src/main/fixtures/fakeQuery';
import { buildNoteSystemPrompt } from '../../src/core/notes/notePrompt';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { Account, AppSettings } from '../../src/shared/types';
import type { NoteAiEvent } from '../../src/shared/notes';

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
      { agent: 'claude-code', model: 'opus', effort: 'high', system: buildNoteSystemPrompt(), prompt: '## 작업 (전체 수정)\n\n## 요청\n정리\n' },
      (t) => deltas.push(t),
      new AbortController().signal,
    );
    expect(res).toEqual({ ok: true, stopped: false });
    expect(deltas.join('')).toContain('FIXTURE-REWRITE: 정리');
    const opts = fake.calls[0].options;
    expect(opts.tools).toEqual([]);
    expect(opts.maxTurns).toBe(1);
    expect(opts.persistSession).toBe(false);
    expect(opts.settingSources).toEqual([]);
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
  function setup() {
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
      git: createNoteGit(() => ({})),
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

  it('aiStart builds the prompt with style refs, streams events and records a summary', async () => {
    const { h, events, runAi } = setup();
    await h['notes:addVault'](undefined);
    const req = {
      requestId: 'r1',
      path: 'Back-End/distlock.md',
      agent: 'claude-code',
      model: null,
      effort: null,
      mode: 'write',
      request: '분산 락',
      document: '',
      target: null,
    };
    await expect(h['notes:aiStart']({ ...req, agent: 'hermes' })).rejects.toThrow();
    await expect(h['notes:aiStart']({ ...req, mode: 'section', target: '  ' })).resolves.toMatchObject({ ok: false });
    expect(await h['notes:aiStart'](req)).toEqual({ ok: true });
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ requestId: 'r1', type: 'done', stopped: false }));
    expect(events[0]).toEqual({ requestId: 'r1', type: 'delta', text: '# 새 노트\n' });
    const run = runAi.mock.calls[0][0];
    expect(run.prompt).toContain('<reference path="Back-End/cache.md">');
    expect(run.system).toContain('좋은 질문입니다');
    const chat = await h['notes:chat']({ path: 'Back-End/distlock.md' });
    expect(chat.map((c) => c.role)).toEqual(['user', 'assistant']);
    expect(chat[1].text).toContain('커서 위치에');
    // Nothing was written into the vault by the request.
    expect(readFileSync(join(vault, 'Back-End', 'distlock.md'), 'utf8')).toBe('# Lock\n\nbody\n');
  });
});
