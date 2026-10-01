import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import type { AppSettings, ModelOption } from '../../../shared/types';
import type { NoteCardMark, NoteChatItem, NoteEntry, NoteGitStatus } from '../../../shared/notes';
import { cleanNoteOutput } from '../../../core/notes/notePrompt';
import { findSection, fitAnswer, fitSelection, planCard, revertCard, type TextChange, type TextRange } from '../../../core/notes/noteEdit';
import type { NoteCard as NoteCardData } from '../../../core/notes/noteReply';
import { baseName, parentOf } from '../../../core/notes/notePaths';
import { tildePath } from '../../../core/format';
import { invoke, on } from '../../api';
import { playSfx } from '../../sound/engine';
import { useAppStore } from '../../store';
import { NOTE_SPLIT, clampSplit, useNotesStore } from '../../store/notesStore';
import { Button, Modal } from '../common';
import { GlyphCommit, GlyphFolderOpen } from '../common/glyphs';
import { IconChevron } from '../Sidebar/icons';
import { NoteChatPanel, useNoteAgentLabel, type NoteChatRun } from './NoteChatPanel';
import { NoteEditor, type NoteEditorHandle } from './NoteEditor';
import { NoteFileDrawer } from './NoteFileDrawer';
import { NoteInlinePrompt, type InlinePromptPlace } from './NoteInlinePrompt';
import { NoteQuickOpen } from './NoteQuickOpen';
import { loadNoteDir, noteError, refreshNoteDirs } from './NoteTree';
import { setTargetRange, targetOf } from './editor/noteTarget';
import { EditorStream, aiChange } from './editor/stream';
import { IconBack, IconNotePage } from './icons';
import './Notes.css';

/** Autosave delay after the last keystroke. */
export const NOTE_AUTOSAVE_MS = 800;
/** How long a card that just landed stays marked. */
const FLASH_MS = 1400;
/** Open overlays an Escape belongs to (same list as the sound hook): they close first, the page stays. */
const OVERLAY = '.hc-popover, .hc-modal, .hc-palette, [role="menu"], [role="dialog"]';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  dirty: '수정됨',
  saving: '저장 중…',
  saved: '저장됨',
  error: '저장 실패',
};

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

type ActiveRun =
  | { requestId: string; kind: 'chat'; path: string; text: string }
  | { requestId: string; kind: 'inline'; path: string; stream: EditorStream; atCaret: boolean };

interface InlineState {
  range: TextRange;
  atCaret: boolean;
  place: InlinePromptPlace;
}

/** The agent / model / effort note requests run with (the composer's chips). */
function engine() {
  const s = useNotesStore.getState();
  const settings = useAppStore.getState().settings;
  const agent = s.agent;
  return {
    agent,
    model: agent === 'codex' ? (s.codexModel ?? settings.codexDefaultModel) : (s.claudeModel ?? settings.defaultModel),
    effort: agent === 'codex' ? (s.codexEffort ?? settings.codexDefaultEffort) : (s.claudeEffort ?? settings.defaultEffort),
  };
}

/** One undoable change made for the user (a card going in or out). */
function dispatchAiChange(view: EditorView, change: TextChange, flash: boolean): void {
  const end = change.from + change.insert.length;
  view.dispatch({
    changes: change,
    selection: { anchor: end },
    effects: [
      ...(flash && end > change.from ? [setTargetRange.of({ from: change.from, to: end, kind: 'flash' as const })] : []),
      EditorView.scrollIntoView(change.from, { y: 'start', yMargin: 48 }),
    ],
    annotations: [aiChange.of('commit'), Transaction.userEvent.of('input.ai'), isolateHistory.of('full')],
  });
}

export interface NotesPageProps {
  settings: AppSettings;
  models: ModelOption[];
  defaultModelLabel: string;
  homeDir: string | null;
  /** "← 돌아가기" / Esc: back to the screen before 노트. */
  onBack: () => void;
}

/** 노트 모드: editor | AI conversation, half and half, over the active vault. Files live in a drawer (breadcrumb, ⌘P). */
export function NotesPage({ settings, models, defaultModelLabel, homeDir, onBack }: NotesPageProps) {
  const vault = settings.activeNoteVault;
  const openPath = useNotesStore((s) => s.openPath);
  const split = useNotesStore((s) => s.split);
  const editor = useRef<NoteEditorHandle>(null);
  const editorPane = useRef<HTMLDivElement>(null);
  const panes = useRef<HTMLDivElement>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [git, setGit] = useState<NoteGitStatus | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitNote, setCommitNote] = useState<string | null>(null);
  /** First 커밋 in a vault: the user confirms turning git on for it first. */
  const [gitOptIn, setGitOptIn] = useState(false);
  const [chat, setChat] = useState<NoteChatItem[]>([]);
  const [chatRun, setChatRun] = useState<NoteChatRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [draftRequest, setDraftRequest] = useState<{ kind: 'file' | 'dir'; nonce: number } | null>(null);
  const [inline, setInline] = useState<InlineState | null>(null);
  const [inlineChars, setInlineChars] = useState<number | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  /** Bumped when the note text settles (opened, saved, a card applied): cards re-check their target section. */
  const [docVersion, setDocVersion] = useState(0);
  const agentLabel = useNoteAgentLabel(models, defaultModelLabel);

  const lastSaved = useRef<string>('');
  const saveTimer = useRef<number | null>(null);
  const savePath = useRef<string | null>(null);
  /** Vault of `savePath`: a write never lands in a vault the note does not belong to. */
  const saveVault = useRef<string>('');
  const run = useRef<ActiveRun | null>(null);
  const inlineRef = useRef<InlineState | null>(null);
  inlineRef.current = inline;
  const flashTimer = useRef<number | null>(null);

  // A different vault: the cached tree and the open note belong to the old one.
  useEffect(() => {
    if (useNotesStore.getState().vault === vault) return;
    useNotesStore.getState().resetVault(vault);
    savePath.current = null;
    lastSaved.current = '';
    editor.current?.load('');
    setChat([]);
    setSave('idle');
    setInline(null);
  }, [vault]);

  // Nothing open: the file drawer is where to start.
  useEffect(() => {
    if (vault && !useNotesStore.getState().openPath) setDrawerOpen(true);
  }, [vault]);

  const refreshGit = useCallback(() => {
    if (!vault) {
      setGit(null);
      return;
    }
    invoke('notes:gitStatus')
      .then(setGit)
      .catch(() => setGit(null));
  }, [vault]);
  useEffect(refreshGit, [refreshGit]);

  const loadChat = useCallback(async (path: string | null): Promise<void> => {
    if (!path) {
      setChat([]);
      return;
    }
    try {
      const items = await invoke('notes:chat', { path });
      if (useNotesStore.getState().openPath === path) setChat(items);
    } catch {
      setChat([]);
    }
  }, []);

  /** Writes the editor text of the open note now (no-op when nothing changed). */
  const saveNow = useCallback(
    async (finalText?: string): Promise<boolean> => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const path = savePath.current;
      // An inline answer streaming into the editor is not saved half-way.
      if (!path || run.current?.kind === 'inline') return true;
      if (saveVault.current !== useAppStore.getState().settings.activeNoteVault) return false;
      // `finalText`: the editor is going away and handed over its last text.
      const text = finalText ?? editor.current?.text() ?? null;
      if (text === null) return true;
      if (text === lastSaved.current) {
        setSave((s) => (s === 'dirty' ? 'saved' : s));
        return true;
      }
      setSave('saving');
      try {
        await invoke('notes:write', { path, text });
        if (savePath.current === path) {
          lastSaved.current = text;
          setSave(editor.current?.text() === text ? 'saved' : 'dirty');
          setSaveError(null);
          setDocVersion((v) => v + 1);
        }
        refreshGit();
        return true;
      } catch (err) {
        setSave('error');
        setSaveError(noteError(err));
        return false;
      }
    },
    [refreshGit],
  );

  const scheduleSave = useCallback(() => {
    setSave('dirty');
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveNow(), NOTE_AUTOSAVE_MS);
  }, [saveNow]);

  const clearMark = useCallback(() => {
    editor.current?.view()?.dispatch({ effects: setTargetRange.of(null) });
  }, []);

  const closeInline = useCallback(
    (refocus: boolean) => {
      if (run.current?.kind === 'inline') return;
      if (!inlineRef.current) return;
      setInline(null);
      setInlineError(null);
      clearMark();
      if (refocus) editor.current?.focus();
    },
    [clearMark],
  );

  const openFile = useCallback(
    async (path: string) => {
      if (run.current) return;
      await saveNow();
      try {
        const file = await invoke('notes:read', { path });
        savePath.current = path;
        saveVault.current = useAppStore.getState().settings.activeNoteVault;
        lastSaved.current = file.text;
        editor.current?.load(file.text);
        useNotesStore.getState().patch({ openPath: path });
        setSave('idle');
        setSaveError(null);
        setAiError(null);
        setInline(null);
        setDrawerOpen(false);
        setQuickOpen(false);
        setDocVersion((v) => v + 1);
        void loadChat(path);
        window.setTimeout(() => editor.current?.focus(), 0);
      } catch (err) {
        setPageError(`노트를 열지 못했습니다: ${noteError(err)}`);
      }
    },
    [saveNow, loadChat],
  );

  // Coming back to the page: reopen the note the store remembers.
  useEffect(() => {
    const path = useNotesStore.getState().openPath;
    if (path && vault) void openFile(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  const closeFile = useCallback(() => {
    savePath.current = null;
    lastSaved.current = '';
    editor.current?.load('');
    useNotesStore.getState().patch({ openPath: null });
    setChat([]);
    setSave('idle');
    setInline(null);
  }, []);

  // Files changed on disk: refresh the tree; reload the open note when it changed and has no unsaved edits.
  useEffect(
    () =>
      on('notes:changed', (change) => {
        if (change.vault !== useAppStore.getState().settings.activeNoteVault) return;
        void refreshNoteDirs(change);
        refreshGit();
        const path = savePath.current;
        if (!path || run.current?.kind === 'inline' || saveTimer.current !== null) return;
        if (!change.all && !change.paths.includes(path)) return;
        invoke('notes:read', { path })
          .then((file) => {
            if (savePath.current !== path || run.current?.kind === 'inline' || saveTimer.current !== null) return;
            const current = editor.current?.text() ?? '';
            if (current !== lastSaved.current) return; // unsaved edits win
            if (file.text !== current) {
              editor.current?.replace(file.text);
              setDocVersion((v) => v + 1);
            }
            lastSaved.current = file.text;
          })
          .catch(() => {});
      }),
    [refreshGit],
  );

  // AI stream events of the running request.
  useEffect(
    () =>
      on('notes:ai', (event) => {
        const active = run.current;
        if (!active || event.requestId !== active.requestId) return;
        if (active.kind === 'chat') {
          if (event.type === 'delta') {
            active.text += event.text;
            setChatRun({ text: active.text });
            return;
          }
          run.current = null;
          setBusy(false);
          // A failed turn (an error, or a Codex turn cancelled at a tool call) keeps nothing of what streamed.
          if (event.type === 'error') {
            setChatRun(null);
            setAiError(event.message);
          }
          void loadChat(active.path).finally(() => setChatRun(null));
          return;
        }
        if (event.type === 'delta') {
          active.stream.delta(event.text);
          setInlineChars(active.stream.streamed.length);
          return;
        }
        // A failed request puts the note back as it was; the prompt stays open with the error.
        const answer = event.type === 'error' ? '' : cleanNoteOutput(active.stream.streamed);
        const final = !answer
          ? null
          : active.atCaret
            ? fitAnswer(answer, 'insert', { original: '', before: active.stream.before, after: active.stream.after })
            : fitSelection(answer, active.stream.original);
        run.current = null;
        setBusy(false);
        setInlineChars(null);
        active.stream.finish(final);
        if (event.type === 'error') {
          setInlineError(event.message);
          const current = inlineRef.current;
          if (current && !current.atCaret) editor.current?.view()?.dispatch({ effects: setTargetRange.of({ ...current.range, kind: 'pending' }) });
          return;
        }
        setInline(null);
        setInlineError(null);
        editor.current?.focus();
        if (final !== null) scheduleSave();
      }),
    [loadChat, scheduleSave],
  );

  // ---- inline prompt ------------------------------------------------------------------------------------------

  /** Where the prompt floats for `range`: under its last line, or over its first when there is no room below. */
  const placeFor = useCallback((view: EditorView, range: TextRange): InlinePromptPlace => {
    const pane = editorPane.current;
    const rect = pane?.getBoundingClientRect();
    if (!pane || !rect) return { top: 80, left: 24, side: 'below' };
    const width = Math.min(440, rect.width - 32);
    const end = view.coordsAtPos(range.to, -1) ?? view.coordsAtPos(range.to);
    const start = view.coordsAtPos(range.from, 1) ?? end;
    if (!end || !start) return { top: 24, left: Math.max(16, (rect.width - width) / 2), side: 'below' };
    const multiLine = end.top > start.bottom - 2;
    const content = view.contentDOM.getBoundingClientRect();
    const anchorX = multiLine ? content.left + 40 : start.left;
    const left = Math.round(Math.min(Math.max(16, anchorX - rect.left - 12), rect.width - width - 16));
    const below = end.bottom - rect.top + 10;
    if (below + 150 <= rect.height || start.top - rect.top < 170) return { top: Math.round(Math.min(below, rect.height - 40)), left, side: 'below' };
    return { top: Math.round(start.top - rect.top - 10), left, side: 'above' };
  }, []);

  const openInline = useCallback(
    (fromKey: boolean) => {
      const view = editor.current?.view();
      if (!view || !savePath.current || run.current) return;
      const sel = view.state.selection.main;
      const range = { from: sel.from, to: sel.to };
      const atCaret = range.from === range.to;
      if (atCaret && !fromKey) return;
      if (!atCaret && !view.state.sliceDoc(range.from, range.to).trim()) return;
      view.dispatch({ effects: setTargetRange.of(atCaret ? null : { ...range, kind: 'pending' }) });
      setInlineError(null);
      setInline({ range, atCaret, place: placeFor(view, range) });
    },
    [placeFor],
  );

  // The prompt follows its range while the editor scrolls or resizes.
  useEffect(() => {
    if (!inline) return;
    const view = editor.current?.view();
    if (!view) return;
    let frame = 0;
    const follow = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = inlineRef.current;
        if (!current) return;
        const mark = targetOf(view.state);
        const range = mark && !current.atCaret ? { from: mark.from, to: mark.to } : current.range;
        setInline({ ...current, place: placeFor(view, range) });
      });
    };
    view.scrollDOM.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', follow);
    return () => {
      cancelAnimationFrame(frame);
      view.scrollDOM.removeEventListener('scroll', follow);
      window.removeEventListener('resize', follow);
    };
  }, [inline !== null, placeFor]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendInline = useCallback(
    async (text: string) => {
      const view = editor.current?.view();
      const path = savePath.current;
      const current = inlineRef.current;
      if (!view || !path || !current || run.current) return;
      const mark = targetOf(view.state);
      const range = !current.atCaret && mark ? { from: mark.from, to: mark.to } : current.range;
      await saveNow();
      const doc = view.state.doc.toString();
      const { agent, model, effort } = engine();
      const requestId = crypto.randomUUID();
      const stream = new EditorStream(view, range);
      run.current = { requestId, kind: 'inline', path, stream, atCaret: current.atCaret };
      setBusy(true);
      setInlineChars(0);
      setInlineError(null);
      try {
        const res = await invoke('notes:aiStart', { requestId, path, agent, model, effort, kind: 'inline', request: text, document: doc, selection: range });
        if (!res.ok) throw new Error(res.error);
      } catch (err) {
        if (run.current?.requestId === requestId) run.current = null;
        stream.finish(null);
        setBusy(false);
        setInlineChars(null);
        setInlineError(noteError(err));
        if (!current.atCaret) view.dispatch({ effects: setTargetRange.of({ ...range, kind: 'pending' }) });
      }
    },
    [saveNow],
  );

  /** ⌫ in the empty prompt: the selection goes, like ⌫ in the editor would have done. */
  const deleteSelection = useCallback(() => {
    const view = editor.current?.view();
    const current = inlineRef.current;
    if (!view || !current || run.current) return;
    const mark = targetOf(view.state);
    const range = mark ?? current.range;
    setInline(null);
    view.dispatch({ changes: { from: range.from, to: range.to, insert: '' }, effects: setTargetRange.of(null), userEvent: 'delete' });
    view.focus();
  }, []);

  // ---- conversation -------------------------------------------------------------------------------------------

  const sendChat = useCallback(
    async (text: string): Promise<boolean> => {
      const path = savePath.current;
      if (!path || run.current) return false;
      await saveNow();
      const doc = editor.current?.text() ?? '';
      const { agent, model, effort } = engine();
      const requestId = crypto.randomUUID();
      run.current = { requestId, kind: 'chat', path, text: '' };
      setBusy(true);
      setChatRun({ text: '' });
      setAiError(null);
      setChat((items) => [...items, { id: `pending-${requestId}`, role: 'user', text, createdAt: Date.now() }]);
      try {
        const res = await invoke('notes:aiStart', { requestId, path, agent, model, effort, kind: 'chat', request: text, document: doc, selection: null });
        if (!res.ok) throw new Error(res.error);
        return true;
      } catch (err) {
        if (run.current?.requestId === requestId) run.current = null;
        setBusy(false);
        setChatRun(null);
        setAiError(noteError(err));
        setChat((items) => items.filter((it) => it.id !== `pending-${requestId}`));
        return false;
      }
    },
    [saveNow],
  );

  const stopRequest = useCallback(() => {
    const active = run.current;
    if (active) void invoke('notes:aiStop', { requestId: active.requestId }).catch(() => {});
  }, []);

  const cardProblem = useCallback(
    (card: NoteCardData): string | null => {
      if (!openPath) return '노트를 먼저 여세요';
      if (card.kind !== 'replace') return null;
      const match = findSection(editor.current?.text() ?? '', card.section ?? '');
      return match.ok ? null : match.error;
    },
    // docVersion: re-check once the text settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openPath, docVersion],
  );

  const markCard = useCallback((itemId: string, index: number, mark: NoteCardMark) => {
    const path = savePath.current;
    if (!path) return;
    setChat((items) => items.map((it) => (it.id === itemId ? { ...it, cards: { ...(it.cards ?? {}), [String(index)]: mark } } : it)));
    void invoke('notes:chatCard', { path, itemId, card: index, mark }).catch((err: unknown) => setAiError(noteError(err)));
  }, []);

  const applyCard = useCallback(
    (itemId: string, index: number, card: NoteCardData) => {
      const view = editor.current?.view();
      if (!view || run.current) return;
      closeInline(false);
      const doc = view.state.doc.toString();
      const planned = planCard(doc, card, view.state.selection.main.head);
      if (!planned.ok) {
        setAiError(planned.error);
        return;
      }
      const { change, original } = planned.plan;
      dispatchAiChange(view, change, true);
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => {
        flashTimer.current = null;
        const v = editor.current?.view();
        if (v && targetOf(v.state)?.kind === 'flash') v.dispatch({ effects: setTargetRange.of(null) });
      }, FLASH_MS);
      setAiError(null);
      setDocVersion((v) => v + 1);
      markCard(itemId, index, { state: 'applied', at: change.from, inserted: change.insert, original });
    },
    [closeInline, markCard],
  );

  const revertApplied = useCallback(
    (itemId: string, index: number, mark: NoteCardMark) => {
      const view = editor.current?.view();
      if (!view || run.current || mark.at === undefined || mark.inserted === undefined || mark.original === undefined) return;
      const change = revertCard(view.state.doc.toString(), { at: mark.at, inserted: mark.inserted, original: mark.original });
      if (!change) {
        setAiError('카드를 넣은 뒤 본문이 바뀌어 자동으로 되돌릴 수 없습니다. 에디터에서 ⌘Z로 되돌리세요.');
        return;
      }
      dispatchAiChange(view, change, false);
      setAiError(null);
      setDocVersion((v) => v + 1);
      markCard(itemId, index, { state: 'reverted' });
    },
    [markCard],
  );

  // ---- files, vaults, git --------------------------------------------------------------------------------------

  const onRenamed = useCallback(
    (from: string, entry: NoteEntry) => {
      const path = savePath.current;
      if (!path || !isUnder(path, from)) return;
      const next = entry.path + path.slice(from.length);
      savePath.current = next;
      useNotesStore.getState().patch({ openPath: next });
      void loadChat(next);
    },
    [loadChat],
  );

  const onTrashed = useCallback(
    (path: string) => {
      const open = savePath.current;
      if (open && isUnder(open, path)) closeFile();
      refreshGit();
    },
    [closeFile, refreshGit],
  );

  const commit = async () => {
    setCommitBusy(true);
    await saveNow();
    try {
      const res = await invoke('notes:commit', { message: commitMsg });
      if (res.ok) {
        setCommitOpen(false);
        setCommitMsg('');
        setCommitNote(`커밋했습니다 · ${res.files}개 파일 · ${res.sha.slice(0, 7)}`);
        window.setTimeout(() => setCommitNote(null), 4000);
      } else setCommitNote(res.error);
    } catch (err) {
      setCommitNote(noteError(err));
    } finally {
      setCommitBusy(false);
      refreshGit();
    }
  };

  /** The user confirmed git for the vault: stored, then the status (now git) and the commit dialog. */
  const enableGit = async () => {
    setCommitBusy(true);
    try {
      await invoke('notes:enableGit');
      setGit(await invoke('notes:gitStatus'));
      setGitOptIn(false);
      setCommitOpen(true);
    } catch (err) {
      setGitOptIn(false);
      setCommitNote(noteError(err));
    } finally {
      setCommitBusy(false);
    }
  };

  const addVault = useCallback(
    () =>
      void saveNow()
        .then(() => invoke('notes:addVault'))
        .catch((err: unknown) => setPageError(`노트 폴더를 등록하지 못했습니다: ${noteError(err)}`)),
    [saveNow],
  );
  const selectVault = useCallback(
    (path: string) =>
      void saveNow()
        .then(() => invoke('notes:selectVault', { path }))
        .catch((err: unknown) => setPageError(noteError(err))),
    [saveNow],
  );
  const removeVault = useCallback(
    () =>
      void saveNow()
        .then(() => invoke('notes:removeVault', { path: vault }))
        .catch((err: unknown) => setPageError(noteError(err))),
    [saveNow, vault],
  );

  // ---- leaving, keys, split -----------------------------------------------------------------------------------

  const goBack = useCallback(() => {
    if (run.current?.kind === 'inline') return;
    onBack();
  }, [onBack]);

  // Esc leaves the page once nothing else wants it (menus, dialogs, the prompt, the drawer, a typed composer);
  // ⌘P opens a note by name.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'p' && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        if (!vault) return;
        e.preventDefault();
        setDrawerOpen(false);
        setQuickOpen(true);
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector(OVERLAY)) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value) return;
      e.preventDefault();
      playSfx('back');
      goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vault, goBack]);

  const startSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const box = panes.current?.getBoundingClientRect();
    if (!box) return;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    document.body.classList.add('hc-notes-resizing');
    const move = (ev: PointerEvent) => useNotesStore.getState().patch({ split: clampSplit((ev.clientX - box.left) / box.width) });
    const up = () => {
      document.body.classList.remove('hc-notes-resizing');
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onSplitKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const s = useNotesStore.getState();
    if (e.key === 'ArrowLeft') s.patch({ split: clampSplit(s.split - step) });
    else if (e.key === 'ArrowRight') s.patch({ split: clampSplit(s.split + step) });
    else if (e.key === 'Home' || e.key === 'Enter') s.patch({ split: NOTE_SPLIT.initial });
    else return;
    e.preventDefault();
  };

  const backButton = (
    <button type="button" className="hc-notes__back" onClick={goBack} aria-label="돌아가기" title="돌아가기 (Esc)" data-testid="notes-back" data-sfx="back">
      <IconBack />
      <span>돌아가기</span>
    </button>
  );

  if (!vault) {
    return (
      <div className="hc-notes hc-notes--empty" data-testid="notes-page">
        <header className="hc-notes__bar hc-notes__bar--solo drag-region">{backButton}</header>
        <div className="hc-notes__setup-wrap">
          <div className="hc-notes__setup">
            <p className="hc-notes__eyebrow">* NOTES</p>
            <h1 className="hc-notes__setup-title">노트 폴더를 지정하세요.</h1>
            <p className="hc-notes__setup-lede">
              폴더 안의 .md 파일을 열고, 쓰는 대로 자동 저장합니다. 왼쪽은 에디터, 오른쪽은 AI 대화입니다. git 저장소라면 여기서 바로 커밋할 수 있습니다.
            </p>
            <Button variant="primary" onClick={addVault} data-testid="notes-add-vault">
              <GlyphFolderOpen width={15} height={15} />
              노트 폴더 지정
            </Button>
            {pageError ? (
              <p className="hc-notes__setup-error" role="alert">
                {pageError}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const vaultName = vault.split('/').filter(Boolean).pop() ?? vault;
  const changed = git?.isRepo && git.enabled ? git.changed.length : 0;
  const dir = openPath ? parentOf(openPath) : '';
  const file = openPath ? baseName(openPath) : '';

  return (
    <div className="hc-notes" data-testid="notes-page">
      <div
        className="hc-notes__panes"
        ref={panes}
        style={{ gridTemplateColumns: `minmax(0, ${split}fr) 0px minmax(0, ${1 - split}fr)` }}
      >
        <section className="hc-notes__left" aria-label="노트 편집기" data-testid="notes-editor-pane">
          <header className="hc-notes__bar drag-region">
            {backButton}
            <button
              type="button"
              className="hc-notes__crumb"
              aria-haspopup="dialog"
              aria-expanded={drawerOpen}
              aria-label={openPath ? `노트 파일: ${openPath}` : '노트 파일 열기'}
              title="노트 파일 (⌘P로 이름 검색)"
              data-testid="notes-breadcrumb"
              onClick={() => setDrawerOpen((v) => !v)}
            >
              <span className="hc-notes__crumb-vault">
                <GlyphFolderOpen width={13} height={13} />
                <span className="hc-notes__crumb-vault-name">{vaultName}</span>
              </span>
              <span className="hc-notes__crumb-path" data-testid="notes-open-path">
                {openPath ? (
                  <>
                    {dir ? <span className="hc-notes__crumb-dir">{dir}/</span> : null}
                    <span className="hc-notes__crumb-file">{file}</span>
                  </>
                ) : null}
              </span>
              {!openPath ? <span className="hc-notes__crumb-none">노트 선택</span> : null}
              <IconChevron className={`hc-notes__crumb-chevron${drawerOpen ? ' hc-notes__crumb-chevron--open' : ''}`} />
            </button>
            <span className={`hc-notes__save hc-notes__save--${save}`} data-testid="notes-save-state" title={saveError ?? undefined} role="status">
              {SAVE_LABEL[save]}
            </span>
            <span className="hc-notes__spacer" />
            {commitNote ? (
              <span className="hc-notes__commit-note" role="status">
                {commitNote}
              </span>
            ) : null}
            {git?.isRepo ? (
              <Button
                size="sm"
                disabled={git.enabled && changed === 0}
                onClick={() => (git.enabled ? setCommitOpen(true) : setGitOptIn(true))}
                data-testid="notes-commit"
                title="변경된 .md 파일만 커밋합니다 (push 없음)"
              >
                <GlyphCommit width={14} height={14} />
                커밋
                {git.enabled ? (
                  <span className="hc-notes__count" data-testid="notes-changed-count">
                    {changed}
                  </span>
                ) : null}
              </Button>
            ) : null}
          </header>
          <div className="hc-notes__editor" ref={editorPane}>
            {pageError ? (
              <div className="hc-notes__notice" role="alert" onClick={() => setPageError(null)}>
                {pageError}
              </div>
            ) : null}
            {!openPath ? (
              <div className="hc-notes__blank">
                <div className="hc-notes__blank-box">
                  <IconNotePage width={28} height={28} className="hc-notes__blank-icon" />
                  <p className="hc-notes__blank-title">열린 노트가 없습니다.</p>
                  <p className="hc-notes__blank-lede">위의 경로를 누르거나 ⌘P로 노트를 여세요.</p>
                  <div className="hc-notes__blank-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        setDrawerOpen(true);
                        setDraftRequest((d) => ({ kind: 'file', nonce: (d?.nonce ?? 0) + 1 }));
                      }}
                    >
                      새 노트
                    </Button>
                    <Button size="sm" onClick={() => setQuickOpen(true)}>
                      노트 열기 <kbd className="hc-notes__kbd">⌘P</kbd>
                    </Button>
                    <Button size="sm" variant="plain" onClick={() => void loadNoteDir('').catch(() => {})}>
                      새로고침
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
            <NoteEditor
              handleRef={editor}
              onEdit={scheduleSave}
              onSave={() => void saveNow()}
              onInlinePrompt={() => openInline(true)}
              onDragSelect={() => openInline(false)}
              onPress={() => closeInline(false)}
              onDispose={(text) => void saveNow(text)}
              hidden={!openPath}
            />
            {inline && openPath ? (
              <NoteInlinePrompt
                key={`${inline.range.from}:${inline.range.to}`}
                place={inline.place}
                atCaret={inline.atCaret}
                agentLabel={agentLabel}
                running={inlineChars}
                error={inlineError}
                onSubmit={(text) => void sendInline(text)}
                onStop={stopRequest}
                onClose={() => closeInline(true)}
                onDeleteSelection={deleteSelection}
              />
            ) : null}
            <NoteFileDrawer
              open={drawerOpen}
              vault={vault}
              vaults={settings.noteVaults}
              homeDir={homeDir}
              openPath={openPath}
              onClose={() => setDrawerOpen(false)}
              onOpenFile={(p) => void openFile(p)}
              onRenamed={onRenamed}
              onTrashed={onTrashed}
              onSelectVault={selectVault}
              onAddVault={addVault}
              onRemoveVault={removeVault}
              draftRequest={draftRequest}
            />
          </div>
        </section>
        <div
          className="hc-notes__split"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="에디터와 대화 너비"
          aria-valuemin={NOTE_SPLIT.min * 100}
          aria-valuemax={NOTE_SPLIT.max * 100}
          aria-valuenow={Math.round(split * 100)}
          title="드래그해서 너비 조절 · 더블클릭하면 반반"
          data-testid="notes-split"
          onPointerDown={startSplit}
          onDoubleClick={() => useNotesStore.getState().patch({ split: NOTE_SPLIT.initial })}
          onKeyDown={onSplitKey}
        />
        <section className="hc-notes__right" aria-label="노트 도우미" data-testid="notes-chat-pane">
          <header className="hc-notes__bar hc-notes__bar--chat drag-region">
            <span className="hc-notes__chat-title">* 노트 도우미</span>
            <span className="hc-notes__chat-sub">{file ? file.replace(/\.md$/i, '') : ''}</span>
          </header>
          <NoteChatPanel
            path={openPath}
            items={chat}
            running={chatRun}
            busy={busy}
            error={aiError}
            onDismissError={() => setAiError(null)}
            models={models}
            defaultModelLabel={defaultModelLabel}
            onSend={sendChat}
            onStop={stopRequest}
            cardProblem={cardProblem}
            onApply={applyCard}
            onRevert={revertApplied}
          />
        </section>
      </div>
      {quickOpen ? <NoteQuickOpen onOpen={(p) => void openFile(p)} onClose={() => setQuickOpen(false)} /> : null}
      <Modal
        open={gitOptIn}
        onClose={() => setGitOptIn(false)}
        title="이 노트 폴더에서 git 사용"
        subtitle={tildePath(vault, homeDir)}
        width={460}
        dismissible={!commitBusy}
        actions={
          <>
            <Button onClick={() => setGitOptIn(false)} disabled={commitBusy}>
              취소
            </Button>
            <Button variant="primary" onClick={() => void enableGit()} disabled={commitBusy} data-testid="notes-git-optin-confirm">
              git 켜기
            </Button>
          </>
        }
      >
        <p className="hc-notes__optin" data-testid="notes-git-optin">
          켜면 이 폴더에서 git을 실행해 바뀐 노트를 확인하고 커밋합니다. 커밋할 때는 저장소에 설정된 hook과 filter가 실행됩니다. 직접 만들었거나 믿을 수 있는 저장소에서만 켜세요. 이 설정은 폴더마다 한 번만 묻습니다.
        </p>
      </Modal>
      <Modal
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        title="노트 커밋"
        subtitle={`변경된 .md ${changed}개를 커밋합니다. push는 하지 않습니다.`}
        width={460}
        dismissible={!commitBusy}
        actions={
          <>
            <Button onClick={() => setCommitOpen(false)} disabled={commitBusy}>
              취소
            </Button>
            <Button variant="primary" onClick={() => void commit()} disabled={commitBusy || !commitMsg.trim()} data-testid="notes-commit-confirm">
              커밋
            </Button>
          </>
        }
      >
        <ul className="hc-notes__commit-files">
          {(git?.changed ?? []).slice(0, 12).map((p) => (
            <li key={p}>{p}</li>
          ))}
          {(git?.changed.length ?? 0) > 12 ? <li>외 {(git?.changed.length ?? 0) - 12}개</li> : null}
        </ul>
        <input
          className="hc-notes__commit-input"
          data-autofocus
          value={commitMsg}
          placeholder="커밋 메시지"
          aria-label="커밋 메시지"
          data-testid="notes-commit-message"
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && commitMsg.trim() && !commitBusy) void commit();
          }}
        />
      </Modal>
    </div>
  );
}
