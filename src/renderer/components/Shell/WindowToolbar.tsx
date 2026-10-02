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
import {
  GlyphChanges as GlyphChangesToggle,
  GlyphList,
  GlyphMarkdown,
  GlyphMore,
  GlyphShare,
  GlyphSoundOff,
  GlyphSoundOn,
  GlyphTerminal as GlyphTerminalToggle,
} from './toolbarGlyphs';
import { useLanguage } from '../../i18n';
import { t } from '../../../shared/i18n';
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
 * 공유 (Markdown file / clipboard), 환경 (git state + actions, subagents, sources), bottom terminal, changes panel,
 * sound on / off.
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
  const language = useLanguage();
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
  const soundOn = useAppStore((s) => s.settings.soundEnabled);

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
    if (thread && thread.projectId === null) {
      // A chat without a project: its scratch folder opens in Finder only (no editors, no git).
      sections.push({
        key: 'editors',
        kind: 'action',
        items: [{ key: 'finder', label: t('plugins.openFolder'), icon: <GlyphFolderOpen />, onSelect: () => onOpenEditor('finder') }],
      });
    } else if (thread && editors.length > 0) {
      sections.push({
        key: 'editors',
        title: t('toolbar.openInEditor'),
        kind: 'action',
        items: editors.map((e) => ({
          key: e.id,
          label: t('env.openIn', { editor: e.name }),
          icon: editorGlyph(e.id),
          meta: e.id === primaryEditor?.id ? t('mode.default') : undefined,
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
        title: t('md.thread'),
        kind: 'action',
        items: [
          { key: 'rename', label: t('toolbar.renameThread'), disabled: !onStartRename, onSelect: () => onStartRename?.() },
          ...(thread.archived
            ? []
            : [{ key: 'pin', label: thread.pinned ? t('thread.unpin') : t('thread.pin'), onSelect: () => onSetPinned(thread.id, !thread.pinned) }]),
          { key: 'archive', label: thread.archived ? t('thread.unarchive') : t('thread.archive'), onSelect: () => onSetArchived(thread.id, !thread.archived) },
          { key: 'delete', label: t('thread.deleteEllipsis'), tone: 'danger' as const, onSelect: () => setConfirmDelete(true) },
        ],
      });
    }
    return sections;
  }, [thread, editors, primaryEditor, accounts, draftPinnedAccountId, onPinAccount, onOpenEditor, onStartRename, onSetPinned, onSetArchived, language]);

  const exportFile = () => {
    if (!thread) return;
    invoke('thread:exportMarkdown', { threadId: thread.id })
      .then((res) => {
        if (res.ok) setFlash({ kind: 'ok', text: t('toolbar.exported') });
        else if (res.error) setFlash({ kind: 'error', text: res.error });
      })
      .catch((err: unknown) => setFlash({ kind: 'error', text: t('toolbar.exportFailed', { error: ipcErrorMessage(err) }) }));
  };

  const copyMarkdown = () => {
    if (!thread) return;
    const items = useAppStore.getState().chatItemsByThread[thread.id] ?? [];
    const projectName = project?.name ?? (thread.projectId === null ? t('folder.noProject') : null);
    const markdown = threadToMarkdown({ title: thread.title, project: projectName, agentName: AGENTS[thread.agent].name }, items);
    void copyText(markdown).then((ok) =>
      setFlash(ok ? { kind: 'ok', text: t('toolbar.copiedMd') } : { kind: 'error', text: t('toolbar.copyFailed') }),
    );
  };

  const shareSections: MenuSection[] = [
    {
      key: 'share',
      kind: 'action',
      items: [
        {
          key: 'file',
          label: t('toolbar.exportMd'),
          description: t('toolbar.exportMd.desc'),
          icon: <GlyphMarkdown />,
          onSelect: exportFile,
        },
        {
          key: 'copy',
          label: t('toolbar.copyMd'),
          description: t('toolbar.copyMd.desc'),
          icon: <GlyphCopy />,
          onSelect: copyMarkdown,
        },
      ],
    },
  ];

  return (
    <div className="hc-toolbar hc-wtb no-drag" role="toolbar" aria-label={t('toolbar.aria')}>
      {flash ? (
        <span className={`hc-wtb__flash hc-wtb__flash--${flash.kind}`} role={flash.kind === 'error' ? 'alert' : 'status'}>
          {flash.text}
        </span>
      ) : null}
      <button
        ref={moreRef}
        type="button"
        className="hc-toolbar-btn hc-toolbar-btn--icon"
        aria-label={t('common.more')}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        title={t('common.more')}
        onClick={() => setMoreOpen((v) => !v)}
      >
        <GlyphMore />
      </button>
      <Menu open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreRef} sections={moreSections} label={t('common.more')} placement="bottom-end" width={280} />
      {thread ? (
        <ConfirmDeletePopover
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          anchorRef={moreRef}
          label={t('thread.delete')}
          message={
            thread.worktree
              ? t('thread.delete.withWorktree', { title: thread.title, branch: thread.worktree.branch })
              : t('thread.delete.message', { title: thread.title })
          }
          forceMessage={t('thread.delete.force')}
          confirmLabel={t('common.delete')}
          onConfirm={(force) => onDeleteThread(thread.id, force)}
        />
      ) : null}

      <button
        ref={shareRef}
        type="button"
        className="hc-toolbar-btn hc-toolbar-btn--icon"
        aria-label={t('toolbar.share')}
        aria-haspopup="menu"
        aria-expanded={shareOpen}
        title={thread ? `${t('toolbar.share')} (Markdown)` : t('toolbar.share.disabled')}
        disabled={!thread}
        onClick={() => setShareOpen((v) => !v)}
      >
        <GlyphShare />
      </button>
      <Menu open={shareOpen} onClose={() => setShareOpen(false)} anchorRef={shareRef} sections={shareSections} label={t('toolbar.share')} placement="bottom-end" width={260} />

      <button
        ref={envRef}
        type="button"
        className={`hc-toolbar-btn hc-toolbar-btn--icon${envOpen ? ' hc-toolbar-btn--on' : ''}`}
        aria-label={t('env.title')}
        aria-haspopup="dialog"
        aria-expanded={envOpen}
        title={thread ? t('env.title') : t('toolbar.env.disabled')}
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
        aria-label={t('terminal.panel')}
        aria-pressed={terminalOpen}
        title={`${terminalOpen ? t('toolbar.terminal.close') : t('toolbar.terminal.open')} (⌘J)`}
        onClick={onToggleTerminal}
      >
        <GlyphTerminalToggle data-glyph="terminal" />
      </button>
      <button
        type="button"
        className={`hc-toolbar-btn hc-toolbar-btn--icon${panel === 'changes' ? ' hc-toolbar-btn--on' : ''}`}
        aria-label={t('toolbar.changesPanel')}
        aria-pressed={panel === 'changes'}
        title={`${t('toolbar.changesPanel')} (⌘⇧D)`}
        onClick={() => onTogglePanel('changes')}
      >
        <GlyphChangesToggle data-glyph="changes" />
      </button>
      <button
        type="button"
        className="hc-toolbar-btn hc-toolbar-btn--icon"
        aria-label={soundOn ? t('toolbar.soundOff') : t('toolbar.soundOn')}
        aria-pressed={soundOn}
        title={soundOn ? t('toolbar.soundOff') : t('toolbar.soundOn')}
        data-testid="sound-toggle"
        data-sfx="none"
        onClick={() =>
          void useAppStore
            .getState()
            .updateSettings({ soundEnabled: !soundOn })
            .catch((err: unknown) => setFlash({ kind: 'error', text: t('toolbar.soundFailed', { error: ipcErrorMessage(err) }) }))
        }
      >
        {soundOn ? <GlyphSoundOn data-glyph="sound-on" /> : <GlyphSoundOff data-glyph="sound-off" />}
      </button>
    </div>
  );
}
