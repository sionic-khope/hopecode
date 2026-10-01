// Invoke handlers of 노트 모드 (notes:*). Same rules as registerIpc: every request is narrowed from `unknown`; the
// renderer names vault-relative paths only and main resolves them inside the active vault (notes/vaultFs.ts).
import type { InvokeResponse } from '../../shared/ipc';
import { NOTE_AGENTS, NOTE_AI_MODES, type NoteAgent, type NoteAiEvent, type NoteAiMode } from '../../shared/notes';
import type { AppSettings } from '../../shared/types';
import { NOTE_VAULTS_MAX } from '../../shared/constants';
import { isNoteVaultPath } from '../../core/settings';
import {
  NOTE_MODE_LABEL,
  REQUEST_MAX_CHARS,
  STYLE_REF_MAX_FILES,
  buildNoteSystemPrompt,
  buildNoteUserPrompt,
  styleRefExcerpt,
} from '../../core/notes/notePrompt';
import { NOTE_MAX_BYTES, normalizeNotePath } from '../../core/notes/notePaths';
import { headingLines } from '../../core/notes/noteEdit';
import type { Broadcaster, Store } from '../contracts';
import type { NoteChats } from '../notes/noteChats';
import type { NoteGit } from '../notes/noteGit';
import type { NoteWatcher } from '../notes/noteWatcher';
import type { NoteAiResult, NoteAiRun } from '../notes/noteAi';
import {
  createEntry,
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
  'notes:aiStart',
  'notes:aiStop',
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

function summary(mode: NoteAiMode, chars: number, result: NoteAiResult, target: string | null): string {
  const n = `${chars.toLocaleString('ko-KR')}자`;
  if (!result.ok) return `실패: ${result.error}`;
  if (result.stopped) return chars > 0 ? `중지했다. 그때까지 받은 ${n}를 반영했다.` : '중지했다. 바뀐 내용은 없다.';
  if (chars === 0) return '받은 내용이 없어 문서를 그대로 두었다.';
  if (mode === 'write') return `커서 위치에 ${n}를 작성했다.`;
  if (mode === 'rewrite') return `문서 전체를 다시 썼다 (${n}).`;
  const title = target ? headingLines(target)[0]?.title : undefined;
  return title ? `「${title}」 섹션을 고쳐 썼다 (${n}).` : `선택한 범위를 고쳐 썼다 (${n}).`;
}

export function buildNotesHandlers(store: Pick<Store, 'get' | 'update'>, broadcaster: Broadcaster, notes: NotesServices): NotesHandlers {
  const running = new Map<string, AbortController>();

  const activeVault = (channel: string): string => {
    const vault = store.get().settings.activeNoteVault;
    assertReq(channel, vault !== '', '노트 폴더를 먼저 지정하세요');
    return vault;
  };

  const saveVaults = (vaults: string[], active: string): AppSettings => {
    store.update((draft) => {
      draft.settings.noteVaults = vaults;
      draft.settings.activeNoteVault = active;
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
      const vault = store.get().settings.activeNoteVault;
      return vault ? notes.git.status(vault) : { isRepo: false, changed: [] };
    },

    'notes:commit': async (req) => {
      assertReq('notes:commit', isPlainObject(req) && isString(req.message), 'message required');
      return notes.git.commit(activeVault('notes:commit'), (req as { message: string }).message);
    },

    'notes:chat': async (req) => {
      assertReq('notes:chat', isPlainObject(req), 'path required');
      return notes.chats.list(activeVault('notes:chat'), needPath('notes:chat', (req as { path?: unknown }).path));
    },

    'notes:aiStart': async (req) => {
      const ch = 'notes:aiStart';
      assertReq(ch, isPlainObject(req), 'request required');
      const r = req as Record<string, unknown>;
      assertReq(ch, isString(r.requestId) && REQUEST_ID.test(r.requestId), 'invalid requestId');
      assertReq(ch, (NOTE_AGENTS as readonly unknown[]).includes(r.agent), 'invalid agent');
      assertReq(ch, (NOTE_AI_MODES as readonly unknown[]).includes(r.mode), 'invalid mode');
      assertReq(ch, isNullableString(r.model) && (r.model === null || r.model.length <= 200), 'invalid model');
      assertReq(ch, isNullableString(r.effort) && (r.effort === null || r.effort.length <= 40), 'invalid effort');
      assertReq(ch, isNonEmptyString(r.request) && r.request.length <= REQUEST_MAX_CHARS, 'request text required');
      assertReq(ch, isString(r.document) && r.document.length <= NOTE_MAX_BYTES, 'document required');
      assertReq(ch, isNullableString(r.target) && (r.target === null || r.target.length <= NOTE_MAX_BYTES), 'invalid target');
      const vault = activeVault(ch);
      const path = needPath(ch, r.path);
      const requestId = r.requestId as string;
      if (running.has(requestId)) return { ok: false, error: '이미 실행 중인 요청입니다' };
      if (running.size >= NOTE_AI_MAX_RUNNING) return { ok: false, error: '진행 중인 요청이 끝난 뒤 다시 보내세요' };
      const mode = r.mode as NoteAiMode;
      const target = mode === 'section' ? (r.target as string | null) : null;
      if (mode === 'section' && !target?.trim()) return { ok: false, error: '고칠 섹션이 비어 있습니다' };

      const refs = await siblingNotes(vault, path, STYLE_REF_MAX_FILES);
      const run: NoteAiRun = {
        agent: r.agent as NoteAgent,
        model: r.model as string | null,
        effort: r.effort as string | null,
        system: buildNoteSystemPrompt(),
        prompt: buildNoteUserPrompt({
          mode,
          request: r.request as string,
          notePath: path,
          document: r.document as string,
          target,
          styleRefs: refs.map((ref) => ({ path: ref.path, excerpt: styleRefExcerpt(ref.text) })),
        }),
      };
      const abort = new AbortController();
      running.set(requestId, abort);
      const emit = (event: NoteAiEvent) => broadcaster.emit('notes:ai', event);
      await notes.chats.append(vault, path, { role: 'user', mode, text: r.request as string });
      void (async () => {
        let chars = 0;
        const result = await notes.runAi(
          run,
          (text) => {
            chars += text.length;
            emit({ requestId, type: 'delta', text });
          },
          abort.signal,
        );
        running.delete(requestId);
        await notes.chats
          .append(vault, path, {
            role: 'assistant',
            mode,
            text: `${NOTE_MODE_LABEL[mode]} · ${summary(mode, chars, result, target)}`,
            status: !result.ok ? 'error' : result.stopped ? 'stopped' : 'done',
          })
          .catch(() => {});
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
