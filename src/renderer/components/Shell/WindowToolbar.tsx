import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, EditorId, EditorInfo, Project, Thread } from '../../../shared/types';
import { AGENTS } from '../../../shared/agents';
import { threadToMarkdown } from '../../../core/threadMarkdown';
import { invoke } from '../../api';
import { copyText } from '../../clipboard';
import { ipcErrorMessage } from '../../errors';
import { useAppStore, type PanelTab } from '../../store';
import { Menu, type MenuSection } from '../common';
import { GlyphCode, GlyphCopy, GlyphFolderOpen, GlyphTerminal } from '../common/glyphs';
import { accountPinSection } from '../Chat/ComposerControls';
import { CommitMenu, type CommitMenuRequest } from '../Changes/CommitMenu';
import { EnvPopover } from '../Env/EnvPopover';
import { ConfirmDeletePopover, type NEEDS_FORCE } from '../Sidebar/ItemMenu';
import { GlyphList, GlyphMarkdown, GlyphMore, GlyphPanelBottom, GlyphPanelRight, GlyphShare } from './toolbarGlyphs';
import './WindowToolbar.css';

export interface WindowToolbarProps {
  /** null: the draft ("new chat") screen -- thread-only items are hidden or disabled. */
  thread: Thread | null;
  project: Project | null;
  accounts: Account[];
  /** Draft's account pin (used while `thread` is null). */
  draftPinnedAccountId: string | null;
  panel: PanelTab | null;
  /** Bottom terminal panel (under the conversation) is open. */
  terminalOpen: boolean;
  editors: EditorInfo[];
  defaultEditor: EditorId | null;
  homeDir: string | null;
  onTogglePanel: (tab: PanelTab) => void;
  onToggleTerminal: () => void;
  onOpenEditor: (editor: EditorId) => void;
  onLoadEditors: () => void;
  /** Thread pin, or the draft's when `thread` is null. */
  onPinAccount: (accountId: string | null) => void;
  onStartRename?: () => void;
  onSetPinned: (threadId: string, pinned: boolean) => void;
  onSetArchived: (threadId: string, archived: boolean) => void;
  onDeleteThread: (threadId: string, force: boolean) => Promise<typeof NEEDS_FORCE | void>;
}

const TERMINALS: readonly EditorId[] = ['terminal', 'iterm', 'ghostty'];

function editorGlyph(id: EditorId) {
  if (id === 'finder') return <GlyphFolderOpen />;
  if (TERMINALS.includes(id)) return <GlyphTerminal />;
  return <GlyphCode />;
}

type Flash = { kind: 'ok' | 'error'; text: string } | null;

/**
 * Top-right window controls, left to right: 더보기 (open in editor, account pin, rename / pin / archive / delete),
 * 공유 (Markdown file / clipboard), 환경 (git state + actions, subagents, sources), bottom terminal, changes panel.
 */
export function WindowToolbar({
  thread,
  project,
  accounts,
  draftPinnedAccountId,
  panel,
  terminalOpen,
  editors,
  defaultEditor,
  homeDir,
  onTogglePanel,
  onToggleTerminal,
  onOpenEditor,
  onLoadEditors,
  onPinAccount,
  onStartRename,
  onSetPinned,
  onSetArchived,
  onDeleteThread,
}: WindowToolbarProps) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const shareRef = useRef<HTMLButtonElement>(null);
  const envRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [commitRequest, setCommitRequest] = useState<CommitMenuRequest | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const threadId = thread?.id ?? null;

  useEffect(() => {
    setMoreOpen(false);
    setShareOpen(false);
    setEnvOpen(false);
    setConfirmDelete(false);
    setCommitRequest(null);
    setFlash(null);
  }, [threadId]);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 3200);
    return () => window.clearTimeout(id);
  }, [flash]);

  useEffect(() => {
    if (moreOpen && editors.length === 0) onLoadEditors();
  }, [moreOpen, editors.length, onLoadEditors]);

  const primaryEditor = editors.find((e) => e.id === defaultEditor) ?? editors[0] ?? null;

  const moreSections = useMemo<MenuSection[]>(() => {
    const sections: MenuSection[] = [];
    if (thread && editors.length > 0) {
      sections.push({
        key: 'editors',
        title: '에디터에서 열기',
        kind: 'action',
        items: editors.map((e) => ({
          key: e.id,
          label: `${e.name}에서 열기`,
          icon: editorGlyph(e.id),
          meta: e.id === primaryEditor?.id ? '기본' : undefined,
          onSelect: () => onOpenEditor(e.id),
        })),
      });
    }
    sections.push(
      accountPinSection(
        accounts,
        thread ? thread.pinnedAccountId : draftPinnedAccountId,
        thread?.activeAccountId ?? null,
        onPinAccount,
      ),
    );
    if (thread) {
      sections.push({
        key: 'thread',
        title: '스레드',
        kind: 'action',
        items: [
          { key: 'rename', label: '스레드 이름 변경', disabled: !onStartRename, onSelect: () => onStartRename?.() },
          ...(thread.archived
            ? []
            : [{ key: 'pin', label: thread.pinned ? '고정 해제' : '고정', onSelect: () => onSetPinned(thread.id, !thread.pinned) }]),
          { key: 'archive', label: thread.archived ? '보관 해제' : '보관', onSelect: () => onSetArchived(thread.id, !thread.archived) },
          { key: 'delete', label: '삭제…', tone: 'danger' as const, onSelect: () => setConfirmDelete(true) },
        ],
      });
    }
    return sections;
  }, [thread, editors, primaryEditor, accounts, draftPinnedAccountId, onPinAccount, onOpenEditor, onStartRename, onSetPinned, onSetArchived]);

  const exportFile = () => {
    if (!thread) return;
    invoke('thread:exportMarkdown', { threadId: thread.id })
      .then((res) => {
        if (res.ok) setFlash({ kind: 'ok', text: 'Markdown 파일로 저장했습니다' });
        else if (res.error) setFlash({ kind: 'error', text: res.error });
      })
      .catch((err: unknown) => setFlash({ kind: 'error', text: `내보내지 못했습니다: ${ipcErrorMessage(err)}` }));
  };

  const copyMarkdown = () => {
    if (!thread) return;
    const items = useAppStore.getState().chatItemsByThread[thread.id] ?? [];
    const markdown = threadToMarkdown({ title: thread.title, project: project?.name ?? null, agentName: AGENTS[thread.agent].name }, items);
    void copyText(markdown).then((ok) =>
      setFlash(ok ? { kind: 'ok', text: 'Markdown을 클립보드에 복사했습니다' } : { kind: 'error', text: '클립보드에 복사하지 못했습니다' }),
    );
  };

  const shareSections: MenuSection[] = [
    {
      key: 'share',
      kind: 'action',
      items: [
        {
          key: 'file',
          label: 'Markdown으로 내보내기…',
          description: '대화를 .md 파일로 저장합니다',
          icon: <GlyphMarkdown />,
          onSelect: exportFile,
        },
        {
          key: 'copy',
          label: 'Markdown 복사',
          description: '대화를 클립보드에 복사합니다',
          icon: <GlyphCopy />,
          onSelect: copyMarkdown,
        },
      ],
    },
  ];

  return (
    <div className="hc-toolbar hc-wtb no-drag" role="toolbar" aria-label="스레드 도구">
      {flash ? (
        <span className={`hc-wtb__flash hc-wtb__flash--${flash.kind}`} role={flash.kind === 'error' ? 'alert' : 'status'}>
          {flash.text}
        </span>
      ) : null}
      <button
        ref={moreRef}
        type="button"
        className="hc-toolbar-btn hc-toolbar-btn--icon"
        aria-label="더보기"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        title="더보기"
        onClick={() => setMoreOpen((v) => !v)}
      >
        <GlyphMore />
      </button>
      <Menu open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreRef} sections={moreSections} label="더보기" placement="bottom-end" width={280} />
      {thread ? (
        <ConfirmDeletePopover
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          anchorRef={moreRef}
          label="스레드 삭제"
          message={
            thread.worktree
              ? `“${thread.title}”을(를) 삭제할까요? 대화 기록과 worktree(${thread.worktree.branch})가 삭제됩니다.`
              : `“${thread.title}”을(를) 삭제할까요? 대화 기록이 삭제됩니다.`
          }
          forceMessage="이 worktree에 커밋하지 않은 변경 사항이 있습니다. 그래도 삭제할까요?"
          confirmLabel="삭제"
          onConfirm={(force) => onDeleteThread(thread.id, force)}
        />
      ) : null}

      <button
        ref={shareRef}
        type="button"
        className="hc-toolbar-btn hc-toolbar-btn--icon"
        aria-label="공유"
        aria-haspopup="menu"
        aria-expanded={shareOpen}
        title={thread ? '공유 (Markdown)' : '대화를 시작하면 공유할 수 있습니다'}
        disabled={!thread}
        onClick={() => setShareOpen((v) => !v)}
      >
        <GlyphShare />
      </button>
      <Menu open={shareOpen} onClose={() => setShareOpen(false)} anchorRef={shareRef} sections={shareSections} label="공유" placement="bottom-end" width={260} />

      <button
        ref={envRef}
        type="button"
        className={`hc-toolbar-btn hc-toolbar-btn--icon${envOpen ? ' hc-toolbar-btn--on' : ''}`}
        aria-label="환경"
        aria-haspopup="dialog"
        aria-expanded={envOpen}
        title={thread ? '환경' : '대화를 시작하면 작업 환경을 볼 수 있습니다'}
        disabled={!thread}
        onClick={() => setEnvOpen((v) => !v)}
      >
        <GlyphList />
      </button>
      {thread ? (
        <>
          <EnvPopover
            open={envOpen}
            onClose={() => setEnvOpen(false)}
            anchorRef={envRef}
            thread={thread}
            project={project}
            homeDir={homeDir}
            editors={editors}
            defaultEditor={defaultEditor}
            onCommit={() => setCommitRequest((r) => ({ kind: 'commit', nonce: (r?.nonce ?? 0) + 1 }))}
            onPushPr={() => setCommitRequest((r) => ({ kind: 'push', nonce: (r?.nonce ?? 0) + 1 }))}
          />
          <CommitMenu thread={thread} anchorRef={envRef} request={commitRequest} />
        </>
      ) : null}

      <span className="hc-wtb__sep" aria-hidden />
      <button
        type="button"
        className={`hc-toolbar-btn hc-toolbar-btn--icon${terminalOpen ? ' hc-toolbar-btn--on' : ''}`}
        aria-label="하단 터미널"
        aria-pressed={terminalOpen}
        title={terminalOpen ? '하단 터미널 닫기 (⌘J)' : '하단 터미널 열기 (⌘J)'}
        onClick={onToggleTerminal}
      >
        <GlyphPanelBottom />
      </button>
      <button
        type="button"
        className={`hc-toolbar-btn hc-toolbar-btn--icon${panel === 'changes' ? ' hc-toolbar-btn--on' : ''}`}
        aria-label="변경사항 패널"
        aria-pressed={panel === 'changes'}
        title="변경사항 패널 (⌘⇧D)"
        onClick={() => onTogglePanel('changes')}
      >
        <GlyphPanelRight />
      </button>
    </div>
  );
}
