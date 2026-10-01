// Invoke handlers of 노트 모드 (notes:*). Same rules as registerIpc: every request is narrowed from `unknown`; the
// renderer names vault-relative paths only and main resolves them inside the active vault (notes/vaultFs.ts).
import type { InvokeResponse } from '../../shared/ipc';
import { NOTE_AGENTS, NOTE_AI_KINDS, type NoteAgent, type NoteAiEvent, type NoteAiKind, type NoteCardMark } from '../../shared/notes';
import type { AppSettings } from '../../shared/types';
import { NOTE_VAULTS_MAX } from '../../shared/constants';
import { isNoteVaultPath } from '../../core/settings';
import {
  HISTORY_MAX_ITEMS,
  REQUEST_MAX_CHARS,
  STYLE_REF_MAX_FILES,
  buildNoteChatPrompt,
  buildNoteInlinePrompt,
  buildNoteSystemPrompt,
  styleRefExcerpt,
} from '../../core/notes/notePrompt';
import { replyProse } from '../../core/notes/noteReply';
import { NOTE_MAX_BYTES, normalizeNotePath } from '../../core/notes/notePaths';
import type { Broadcaster, Store } from '../contracts';
import type { NoteChats } from '../notes/noteChats';
import type { NoteGit } from '../notes/noteGit';
import type { NoteWatcher } from '../notes/noteWatcher';
import type { NoteAiResult, NoteAiRun } from '../notes/noteAi';
import {
  createEntry,
  isTooBroadVault,
  listDir,
  readNote,
  renameEntry,
  searchNames,
  siblingNotes,
  trashEntry,
  vaultRoot,
  writeNote,
} from '../notes/vaultFs';
import { assertReq, isNonEmptyString, isNullableString, isPlainObject, isString } from './guards';

export const NOTES_CHANNELS = [
  'notes:addVault',
  'notes:selectVault',
  'notes:removeVault',
  'notes:listDir',
  'notes:search',
  'notes:read',
  'notes:write',
  'notes:create',
  'notes:rename',
  'notes:trash',
  'notes:openLink',
  'notes:gitStatus',
  'notes:commit',
  'notes:chat',
  'notes:chatCard',
  'notes:aiStart',
  'notes:aiStop',
  'notes:enableGit',
] as const;

export type NotesChannel = (typeof NOTES_CHANNELS)[number];
export type NotesHandlers = { [K in NotesChannel]: (req: unknown) => Promise<InvokeResponse<K>> };

/** Note AI requests running at once (all notes together). */
export const NOTE_AI_MAX_RUNNING = 3;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface NotesServices {
  /** Native folder picker (a seam in test runs); null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Moves an absolute path (already contained) to the Trash. */
  trash(abs: string): Promise<void>;
  /** https links only; false when refused. */
  openExternal(url: string): boolean;
  git: NoteGit;
  chats: NoteChats;
  watcher: NoteWatcher;
  /** runNoteAi bound to its deps. */
  runAi(run: NoteAiRun, onDelta: (text: string) => void, signal: AbortSignal): Promise<NoteAiResult>;
}

const isOffset = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= NOTE_MAX_BYTES;

/** A card mark from the renderer, narrowed (null clears). */
function cardMarkOf(raw: unknown): NoteCardMark | null | undefined {
  if (raw === null) return null;
  if (!isPlainObject(raw) || (raw.state !== 'applied' && raw.state !== 'reverted')) return undefined;
  const mark: NoteCardMark = { state: raw.state };
  if (raw.state === 'applied' && isOffset(raw.at) && isString(raw.inserted) && isString(raw.original)) {
    if (raw.inserted.length + raw.original.length <= NOTE_MAX_BYTES * 2) Object.assign(mark, { at: raw.at, inserted: raw.inserted, original: raw.original });
  }
  return mark;
}

export function buildNotesHandlers(store: Pick<Store, 'get' | 'update'>, broadcaster: Broadcaster, notes: NotesServices): NotesHandlers {
  const running = new Map<string, AbortController>();

  const activeVault = (channel: string): string => {
    const vault = store.get().settings.activeNoteVault;
    assertReq(channel, vault !== '', '노트 폴더를 먼저 지정하세요');
    return vault;
  };

  const saveVaults = (vaults: string[], active: string, gitVaults = store.get().settings.noteGitVaults): AppSettings => {
    store.update((draft) => {
      draft.settings.noteVaults = vaults;
      draft.settings.activeNoteVault = active;
      draft.settings.noteGitVaults = gitVaults.filter((v) => vaults.includes(v));
    });
    const next = store.get().settings;
    notes.watcher.set(next.activeNoteVault || null);
    broadcaster.emit('settings:updated', next);
    return next;
  };

  const needPath = (channel: string, raw: unknown, allowRoot = false): string => {
    const rel = normalizeNotePath(raw, { allowRoot });
    assertReq(channel, rel !== null, 'invalid path');
    return rel as string;
  };

  notes.watcher.set(store.get().settings.activeNoteVault || null);

  return {
    'notes:addVault': async () => {
      const picked = await notes.pickFolder();
      const { noteVaults } = store.get().settings;
      if (!picked) return store.get().settings;
      const real = await vaultRoot(picked);
      assertReq('notes:addVault', isNoteVaultPath(real), 'invalid folder');
      assertReq('notes:addVault', !(await isTooBroadVault(real)), '홈 폴더나 디스크 최상위 폴더는 노트 폴더로 쓸 수 없습니다');
      if (noteVaults.includes(real)) return saveVaults(noteVaults, real);
      assertReq('notes:addVault', noteVaults.length < NOTE_VAULTS_MAX, `노트 폴더는 ${NOTE_VAULTS_MAX}개까지 등록할 수 있습니다`);
      return saveVaults([...noteVaults, real], real);
    },

    'notes:selectVault': async (req) => {
      assertReq('notes:selectVault', isPlainObject(req) && isString(req.path), 'path required');
      const { noteVaults } = store.get().settings;
      const path = (req as { path: string }).path;
      assertReq('notes:selectVault', noteVaults.includes(path), 'unknown vault');
      return saveVaults(noteVaults, path);
    },

    'notes:removeVault': async (req) => {
      assertReq('notes:removeVault', isPlainObject(req) && isString(req.path), 'path required');
      const { noteVaults, activeNoteVault } = store.get().settings;
      const path = (req as { path: string }).path;
      assertReq('notes:removeVault', noteVaults.includes(path), 'unknown vault');
      const rest = noteVaults.filter((v) => v !== path);
      return saveVaults(rest, activeNoteVault === path ? (rest[0] ?? '') : activeNoteVault);
    },

    'notes:listDir': async (req) => {
      assertReq('notes:listDir', isPlainObject(req), 'dir required');
      const dir = needPath('notes:listDir', (req as { dir?: unknown }).dir, true);
      return listDir(activeVault('notes:listDir'), dir);
    },

    'notes:search': async (req) => {
      assertReq('notes:search', isPlainObject(req) && isString(req.query) && req.query.length <= 200, 'query required');
      return searchNames(activeVault('notes:search'), (req as { query: string }).query);
    },

    'notes:read': async (req) => {
      assertReq('notes:read', isPlainObject(req), 'path required');
      return readNote(activeVault('notes:read'), needPath('notes:read', (req as { path?: unknown }).path));
    },

    'notes:write': async (req) => {
      assertReq('notes:write', isPlainObject(req) && isString(req.text) && req.text.length <= NOTE_MAX_BYTES, 'path/text required');
      const { path, text } = req as { path?: unknown; text: string };
      return writeNote(activeVault('notes:write'), needPath('notes:write', path), text);
    },

    'notes:create': async (req) => {
      assertReq('notes:create', isPlainObject(req) && (req.kind === 'file' || req.kind === 'dir'), 'path/kind required');
      const { path, kind } = req as { path?: unknown; kind: 'file' | 'dir' };
      return createEntry(activeVault('notes:create'), needPath('notes:create', path), kind);
    },

    'notes:rename': async (req) => {
      assertReq('notes:rename', isPlainObject(req) && isString(req.name), 'path/name required');
      const { path, name } = req as { path?: unknown; name: string };
      const vault = activeVault('notes:rename');
      const from = needPath('notes:rename', path);
      const entry = await renameEntry(vault, from, name);
      if (entry.kind === 'file' && entry.path !== from) await notes.chats.move(vault, from, entry.path);
      return entry;
    },

    'notes:trash': async (req) => {
      assertReq('notes:trash', isPlainObject(req), 'path required');
      await trashEntry(activeVault('notes:trash'), needPath('notes:trash', (req as { path?: unknown }).path), notes.trash);
    },

    'notes:openLink': async (req) => {
      assertReq('notes:openLink', isPlainObject(req) && isString(req.url) && req.url.length <= 2048, 'url required');
      return notes.openExternal((req as { url: string }).url);
    },

    'notes:gitStatus': async () => {
      const { activeNoteVault: vault, noteGitVaults } = store.get().settings;
      if (!vault) return { isRepo: false, enabled: false, changed: [] };
      // Before the user turned git on for the vault, only file checks run (no git process).
      if (!noteGitVaults.includes(vault)) return { isRepo: await notes.git.detect(vault).catch(() => false), enabled: false, changed: [] };
      return { ...(await notes.git.status(vault)), enabled: true };
    },

    'notes:enableGit': async () => {
      const vault = activeVault('notes:enableGit');
      const { noteVaults, noteGitVaults } = store.get().settings;
      if (noteGitVaults.includes(vault)) return store.get().settings;
      return saveVaults(noteVaults, vault, [...noteGitVaults, vault]);
    },

    'notes:commit': async (req) => {
      assertReq('notes:commit', isPlainObject(req) && isString(req.message), 'message required');
      const vault = activeVault('notes:commit');
      assertReq('notes:commit', store.get().settings.noteGitVaults.includes(vault), '이 노트 폴더는 git 기능이 꺼져 있습니다');
      return notes.git.commit(vault, (req as { message: string }).message);
    },

    'notes:chat': async (req) => {
      assertReq('notes:chat', isPlainObject(req), 'path required');
      return notes.chats.list(activeVault('notes:chat'), needPath('notes:chat', (req as { path?: unknown }).path));
    },

    'notes:chatCard': async (req) => {
      const ch = 'notes:chatCard';
      assertReq(ch, isPlainObject(req) && isNonEmptyString(req.itemId) && (req.itemId as string).length <= 64, 'itemId required');
      const r = req as Record<string, unknown>;
      assertReq(ch, typeof r.card === 'number' && Number.isInteger(r.card) && r.card >= 0 && r.card < 1000, 'invalid card');
      const mark = cardMarkOf(r.mark);
      assertReq(ch, mark !== undefined, 'invalid mark');
      return notes.chats.markCard(activeVault(ch), needPath(ch, r.path), r.itemId as string, r.card as number, mark as NoteCardMark | null);
    },

    'notes:aiStart': async (req) => {
      const ch = 'notes:aiStart';
      assertReq(ch, isPlainObject(req), 'request required');
      const r = req as Record<string, unknown>;
      assertReq(ch, isString(r.requestId) && REQUEST_ID.test(r.requestId), 'invalid requestId');
      assertReq(ch, (NOTE_AGENTS as readonly unknown[]).includes(r.agent), 'invalid agent');
      assertReq(ch, (NOTE_AI_KINDS as readonly unknown[]).includes(r.kind), 'invalid kind');
      assertReq(ch, isNullableString(r.model) && (r.model === null || r.model.length <= 200), 'invalid model');
      assertReq(ch, isNullableString(r.effort) && (r.effort === null || r.effort.length <= 40), 'invalid effort');
      assertReq(ch, isNonEmptyString(r.request) && r.request.length <= REQUEST_MAX_CHARS, 'request text required');
      assertReq(ch, isString(r.document) && r.document.length <= NOTE_MAX_BYTES, 'document required');
      const kind = r.kind as NoteAiKind;
      const document = r.document as string;
      let selection: { from: number; to: number } | null = null;
      if (kind === 'inline') {
        const sel = r.selection;
        assertReq(ch, isPlainObject(sel) && isOffset(sel.from) && isOffset(sel.to), 'selection required');
        const { from, to } = sel as { from: number; to: number };
        assertReq(ch, from <= to && to <= document.length, 'invalid selection');
        selection = { from, to };
      } else {
        assertReq(ch, r.selection === null || r.selection === undefined, 'invalid selection');
      }
      const vault = activeVault(ch);
      const path = needPath(ch, r.path);
      const requestId = r.requestId as string;
      if (running.has(requestId)) return { ok: false, error: '이미 실행 중인 요청입니다' };
      if (running.size >= NOTE_AI_MAX_RUNNING) return { ok: false, error: '진행 중인 요청이 끝난 뒤 다시 보내세요' };
      if (selection && selection.from < selection.to && !document.slice(selection.from, selection.to).trim()) {
        return { ok: false, error: '고칠 부분이 비어 있습니다' };
      }

      const refs = await siblingNotes(vault, path, STYLE_REF_MAX_FILES);
      const styleRefs = refs.map((ref) => ({ path: ref.path, excerpt: styleRefExcerpt(ref.text) }));
      const request = r.request as string;
      let prompt: string;
      if (selection) {
        prompt = buildNoteInlinePrompt({ request, notePath: path, document, selection, styleRefs });
      } else {
        const earlier = (await notes.chats.list(vault, path)).filter((it) => it.status !== 'error').slice(-HISTORY_MAX_ITEMS);
        const history = earlier.map((it) => ({ role: it.role, text: it.role === 'assistant' ? replyProse(it.text) : it.text }));
        prompt = buildNoteChatPrompt({ request, notePath: path, document, history, styleRefs });
      }
      const run: NoteAiRun = {
        agent: r.agent as NoteAgent,
        model: r.model as string | null,
        effort: r.effort as string | null,
        system: buildNoteSystemPrompt(),
        prompt,
      };
      const abort = new AbortController();
      running.set(requestId, abort);
      const emit = (event: NoteAiEvent) => broadcaster.emit('notes:ai', event);
      // Only the conversation is recorded; an inline edit lives in the editor's undo history.
      if (kind === 'chat') await notes.chats.append(vault, path, { role: 'user', text: request });
      void (async () => {
        let text = '';
        const result = await notes.runAi(
          run,
          (delta) => {
            text += delta;
            emit({ requestId, type: 'delta', text: delta });
          },
          abort.signal,
        );
        running.delete(requestId);
        if (kind === 'chat') {
          // A failed run keeps only its error: what streamed before it (a Codex turn cut at a tool call) is dropped.
          const row = !result.ok
            ? { role: 'assistant' as const, text: result.error, status: 'error' as const }
            : { role: 'assistant' as const, text: text.trim() ? text : result.stopped ? '중지했다.' : '받은 내용이 없다.', status: result.stopped ? ('stopped' as const) : ('done' as const) };
          await notes.chats.append(vault, path, row).catch(() => {});
        }
        emit(result.ok ? { requestId, type: 'done', stopped: result.stopped } : { requestId, type: 'error', message: result.error });
      })();
      return { ok: true };
    },

    'notes:aiStop': async (req) => {
      assertReq('notes:aiStop', isPlainObject(req) && isString(req.requestId), 'requestId required');
      running.get((req as { requestId: string }).requestId)?.abort();
    },
  };
}
