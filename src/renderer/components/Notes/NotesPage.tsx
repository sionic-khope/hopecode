import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AppSettings, ModelOption } from '../../../shared/types';
import type { NoteAiMode, NoteChatItem, NoteEntry, NoteGitStatus } from '../../../shared/notes';
import { cleanNoteOutput } from '../../../core/notes/notePrompt';
import { fitAnswer, type TextRange } from '../../../core/notes/noteEdit';
import { tildePath } from '../../../core/format';
import { invoke, on } from '../../api';
import { useAppStore } from '../../store';
import { NOTE_CHAT_W, NOTE_TREE_W, useNotesStore, type NoteViewMode } from '../../store/notesStore';
import { Button, Menu, Modal, Segmented, type MenuSection } from '../common';
import { GlyphCommit, GlyphFolderOpen } from '../common/glyphs';
import { IconChevron } from '../Sidebar/icons';
import { NoteChatPanel, type NoteRunState } from './NoteChatPanel';
import { NoteEditor, type NoteEditorHandle } from './NoteEditor';
import { NotePreview } from './NotePreview';
import { NoteTree, loadNoteDir, noteError, refreshNoteDirs } from './NoteTree';
import { currentSection } from './editor/noteTarget';
import { EditorStream } from './editor/stream';
import { IconPane } from './icons';
import './Notes.css';

/** Autosave delay after the last keystroke. */
export const NOTE_AUTOSAVE_MS = 800;

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  dirty: '수정됨',
  saving: '저장 중…',
  saved: '저장됨',
  error: '저장 실패',
};

const VIEW_OPTIONS: { value: NoteViewMode; label: string; title: string }[] = [
  { value: 'source', label: '소스', title: '마크다운 원문' },
  { value: 'live', label: 'Live', title: 'Live Preview: 커서가 없는 줄은 서식이 적용된 모습으로 보입니다' },
  { value: 'preview', label: '읽기', title: '읽기 전용 미리보기' },
];

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

interface ActiveRun {
  requestId: string;
  mode: NoteAiMode;
  path: string;
  stream: EditorStream;
}

export interface NotesPageProps {
  settings: AppSettings;
  models: ModelOption[];
  defaultModelLabel: string;
  homeDir: string | null;
}

/** 노트 모드: file tree · markdown editor (Live Preview) · AI panel, over the active vault. */
export function NotesPage({ settings, models, defaultModelLabel, homeDir }: NotesPageProps) {
  const vault = settings.activeNoteVault;
  const ui = useNotesStore();
  const editor = useRef<NoteEditorHandle>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [git, setGit] = useState<NoteGitStatus | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitNote, setCommitNote] = useState<string | null>(null);
  const [vaultMenu, setVaultMenu] = useState(false);
  const vaultRef = useRef<HTMLButtonElement>(null);
  const [chat, setChat] = useState<NoteChatItem[]>([]);
  const [running, setRunning] = useState<NoteRunState | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);

  const openPath = ui.openPath;
  const lastSaved = useRef<string>('');
  const saveTimer = useRef<number | null>(null);
  const savePath = useRef<string | null>(null);
  /** Vault of `savePath`: a write never lands in a vault the note does not belong to. */
  const saveVault = useRef<string>('');
  const run = useRef<ActiveRun | null>(null);

  // A different vault: the cached tree and the open note belong to the old one.
  useEffect(() => {
    if (useNotesStore.getState().vault === vault) return;
    useNotesStore.getState().resetVault(vault);
    savePath.current = null;
    lastSaved.current = '';
    editor.current?.load('');
    setChat([]);
    setSave('idle');
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

  const loadChat = useCallback((path: string | null) => {
    if (!path) {
      setChat([]);
      return;
    }
    invoke('notes:chat', { path })
      .then((items) => {
        if (useNotesStore.getState().openPath === path) setChat(items);
      })
      .catch(() => setChat([]));
  }, []);

  /** Writes the editor text of the open note now (no-op when nothing changed). */
  const saveNow = useCallback(async (finalText?: string): Promise<boolean> => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const path = savePath.current;
    if (!path || run.current) return true;
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
      }
      refreshGit();
      return true;
    } catch (err) {
      setSave('error');
      setSaveError(noteError(err));
      return false;
    }
  }, [refreshGit]);

  const scheduleSave = useCallback(() => {
    setSave('dirty');
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveNow(), NOTE_AUTOSAVE_MS);
  }, [saveNow]);

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
        setPreviewText(file.text);
        useNotesStore.getState().patch({ openPath: path });
        setSave('idle');
        setSaveError(null);
        setAiError(null);
        loadChat(path);
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
    setPreviewText('');
    useNotesStore.getState().patch({ openPath: null });
    setChat([]);
    setSave('idle');
  }, []);

  // Files changed on disk: refresh the tree; reload the open note when it changed and has no unsaved edits.
  useEffect(
    () =>
      on('notes:changed', (change) => {
        if (change.vault !== useAppStore.getState().settings.activeNoteVault) return;
        void refreshNoteDirs(change);
        refreshGit();
        const path = savePath.current;
        if (!path || run.current || saveTimer.current !== null) return;
        if (!change.all && !change.paths.includes(path)) return;
        invoke('notes:read', { path })
          .then((file) => {
            if (savePath.current !== path || run.current || saveTimer.current !== null) return;
            const current = editor.current?.text() ?? '';
            if (current !== lastSaved.current) return; // unsaved edits win
            if (file.text !== current) {
              editor.current?.replace(file.text);
              setPreviewText(file.text);
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
        if (event.type === 'delta') {
          active.stream.delta(event.text);
          setRunning({ mode: active.mode, chars: active.stream.streamed.length });
          return;
        }
        const answer = cleanNoteOutput(active.stream.streamed);
        const final = answer ? fitAnswer(answer, active.mode, { original: active.stream.original, before: active.stream.before, after: active.stream.after }) : null;
        run.current = null;
        active.stream.finish(final);
        setRunning(null);
        if (event.type === 'error') setAiError(event.message);
        setPreviewText(editor.current?.text() ?? '');
        loadChat(active.path);
        if (final !== null) scheduleSave();
      }),
    [loadChat, scheduleSave],
  );

  const sendRequest = useCallback(
    async (text: string): Promise<boolean> => {
      const view = editor.current?.view();
      const path = savePath.current;
      if (!view || !path || run.current) return false;
      const mode = useNotesStore.getState().aiMode;
      const doc = view.state.doc.toString();
      let range: TextRange;
      if (mode === 'rewrite' || doc.trim() === '') range = { from: 0, to: doc.length };
      else if (mode === 'section') range = currentSection(view);
      else {
        const head = view.state.selection.main.head;
        range = { from: head, to: head };
      }
      await saveNow();
      const s = useNotesStore.getState();
      const settingsNow = useAppStore.getState().settings;
      const agent = s.agent;
      const model = agent === 'codex' ? (s.codexModel ?? settingsNow.codexDefaultModel) : (s.claudeModel ?? settingsNow.defaultModel);
      const effort = agent === 'codex' ? (s.codexEffort ?? settingsNow.codexDefaultEffort) : (s.claudeEffort ?? settingsNow.defaultEffort);
      const requestId = crypto.randomUUID();
      const stream = new EditorStream(view, range);
      run.current = { requestId, mode, path, stream };
      setRunning({ mode, chars: 0 });
      setAiError(null);
      try {
        const res = await invoke('notes:aiStart', {
          requestId,
          path,
          agent,
          model,
          effort,
          mode,
          request: text,
          document: doc,
          target: mode === 'section' ? doc.slice(range.from, range.to) : null,
        });
        if (!res.ok) throw new Error(res.error);
        loadChat(path);
        return true;
      } catch (err) {
        if (run.current?.requestId === requestId) run.current = null;
        stream.finish(null);
        setRunning(null);
        setAiError(noteError(err));
        return false;
      }
    },
    [saveNow, loadChat],
  );

  const stopRequest = useCallback(() => {
    const active = run.current;
    if (active) void invoke('notes:aiStop', { requestId: active.requestId }).catch(() => {});
  }, []);

  const onRenamed = useCallback(
    (from: string, entry: NoteEntry) => {
      const path = savePath.current;
      if (!path || !isUnder(path, from)) return;
      const next = entry.path + path.slice(from.length);
      savePath.current = next;
      useNotesStore.getState().patch({ openPath: next });
      loadChat(next);
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

  const setView = (view: NoteViewMode) => {
    if (view === 'preview') setPreviewText(editor.current?.text() ?? '');
    ui.patch({ view });
  };

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

  const addVault = () =>
    void saveNow()
      .then(() => invoke('notes:addVault')).catch((err: unknown) => setPageError(`노트 폴더를 등록하지 못했습니다: ${noteError(err)}`));

  // Pane resize (pointer capture on the handle; widths clamp to the store bounds).
  const startResize = (which: 'tree' | 'chat') => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const s = useNotesStore.getState();
    const start = which === 'tree' ? s.treeW : s.chatW;
    const bounds = which === 'tree' ? NOTE_TREE_W : NOTE_CHAT_W;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const w = Math.round(Math.min(bounds.max, Math.max(bounds.min, which === 'tree' ? start + dx : start - dx)));
      useNotesStore.getState().patch(which === 'tree' ? { treeW: w } : { chatW: w });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  if (!vault) {
    return (
      <div className="hc-notes hc-notes--empty" data-testid="notes-page">
        <div className="hc-notes__setup">
          <h1 className="hc-notes__setup-title">노트</h1>
          <p className="hc-notes__setup-lede">
            마크다운 노트 폴더를 지정하세요. 폴더 안의 .md 파일을 트리로 열고, 쓰는 대로 자동 저장합니다. git 저장소라면 여기서 바로 커밋할 수 있습니다.
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
    );
  }

  const vaultName = vault.split('/').filter(Boolean).pop() ?? vault;
  const vaultSections: MenuSection[] = [
    {
      key: 'vaults',
      title: '노트 폴더',
      kind: 'radio',
      items: settings.noteVaults.map((v) => ({
        key: v,
        label: v.split('/').filter(Boolean).pop() ?? v,
        description: tildePath(v, homeDir),
        checked: v === vault,
        onSelect: () =>
          void saveNow()
            .then(() => invoke('notes:selectVault', { path: v }))
            .catch((err: unknown) => setPageError(noteError(err))),
      })),
    },
    {
      key: 'actions',
      kind: 'action',
      items: [
        { key: 'add', label: '다른 폴더 추가…', icon: <GlyphFolderOpen width={15} height={15} />, onSelect: addVault },
        {
          key: 'remove',
          label: '이 폴더 목록에서 빼기',
          tone: 'danger',
          description: '파일은 지우지 않습니다',
          onSelect: () =>
            void saveNow()
              .then(() => invoke('notes:removeVault', { path: vault }))
              .catch((err: unknown) => setPageError(noteError(err))),
        },
      ],
    },
  ];

  const changed = git?.isRepo ? git.changed.length : 0;
  const gridCols = `${ui.treeOpen ? `${ui.treeW}px 6px` : ''} minmax(0, 1fr) ${ui.chatOpen ? `6px ${ui.chatW}px` : ''}`.trim();

  return (
    <div className="hc-notes" data-testid="notes-page">
      <div className="hc-notes__bar">
        <Button variant="plain" size="sm" icon aria-label={ui.treeOpen ? '파일 트리 접기' : '파일 트리 펼치기'} onClick={() => ui.patch({ treeOpen: !ui.treeOpen })}>
          <IconPane side="left" />
        </Button>
        <button
          ref={vaultRef}
          type="button"
          className="hc-notes__vault"
          aria-haspopup="menu"
          aria-expanded={vaultMenu}
          data-testid="notes-vault"
          title={tildePath(vault, homeDir)}
          onClick={() => setVaultMenu((v) => !v)}
        >
          <GlyphFolderOpen width={14} height={14} />
          <span>{vaultName}</span>
          <IconChevron className="hc-notes__vault-chevron" />
        </button>
        <Menu open={vaultMenu} onClose={() => setVaultMenu(false)} anchorRef={vaultRef} sections={vaultSections} label="노트 폴더" placement="bottom-start" width={300} />
        <span className="hc-notes__path" data-testid="notes-open-path">
          {openPath ?? ''}
        </span>
        <span className={`hc-notes__save hc-notes__save--${save}`} data-testid="notes-save-state" title={saveError ?? undefined}>
          {SAVE_LABEL[save]}
        </span>
        <span className="hc-notes__spacer" />
        {commitNote ? (
          <span className="hc-notes__commit-note" role="status">
            {commitNote}
          </span>
        ) : null}
        {git?.isRepo ? (
          <Button size="sm" disabled={changed === 0} onClick={() => setCommitOpen(true)} data-testid="notes-commit" title="변경된 .md 파일만 커밋합니다 (push 없음)">
            <GlyphCommit width={14} height={14} />
            커밋
            <span className="hc-notes__count" data-testid="notes-changed-count">
              {changed}
            </span>
          </Button>
        ) : null}
        <Segmented options={VIEW_OPTIONS} value={ui.view} onChange={setView} size="sm" aria-label="보기" />
        <Button variant="plain" size="sm" icon aria-label={ui.chatOpen ? 'AI 패널 접기' : 'AI 패널 펼치기'} onClick={() => ui.patch({ chatOpen: !ui.chatOpen })}>
          <IconPane side="right" />
        </Button>
      </div>
      {pageError ? (
        <div className="hc-notes__notice" role="alert" onClick={() => setPageError(null)}>
          {pageError}
        </div>
      ) : null}
      <div className="hc-notes__panes" style={{ gridTemplateColumns: gridCols }}>
        {ui.treeOpen ? (
          <>
            <aside className="hc-notes__tree" aria-label="노트 파일">
              <NoteTree vault={vault} openPath={openPath} onOpen={(p) => void openFile(p)} onRenamed={onRenamed} onTrashed={onTrashed} />
            </aside>
            <div className="hc-notes__resizer" role="separator" aria-orientation="vertical" aria-label="파일 트리 너비" onPointerDown={startResize('tree')} />
          </>
        ) : null}
        <section className="hc-notes__editor" aria-label="노트 편집기">
          {!openPath ? (
            <div className="hc-notes__placeholder">
              <p>왼쪽에서 노트를 열거나 새 노트를 만드세요.</p>
              <Button size="sm" onClick={() => void loadNoteDir('')}>
                트리 새로고침
              </Button>
            </div>
          ) : null}
          <NoteEditor
            handleRef={editor}
            live={ui.view !== 'source'}
            sectionTracking={ui.aiMode === 'section' && running === null}
            onEdit={scheduleSave}
            onSave={() => void saveNow()}
            onDispose={(text) => void saveNow(text)}
            hidden={!openPath || ui.view === 'preview'}
          />
          {openPath && ui.view === 'preview' ? <NotePreview text={previewText} /> : null}
        </section>
        {ui.chatOpen ? (
          <>
            <div className="hc-notes__resizer" role="separator" aria-orientation="vertical" aria-label="AI 패널 너비" onPointerDown={startResize('chat')} />
            <aside className="hc-notes__chat" aria-label="노트 도우미">
              <NoteChatPanel
                path={openPath}
                items={chat}
                running={running}
                error={aiError}
                models={models}
                defaultModelLabel={defaultModelLabel}
                onSend={sendRequest}
                onStop={stopRequest}
              />
            </aside>
          </>
        ) : null}
      </div>
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
