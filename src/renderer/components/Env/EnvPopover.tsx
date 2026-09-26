import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { EditorId, EditorInfo, GitChanges, Project, Thread } from '../../../shared/types';
import { branchNameError } from '../../../core/branchName';
import { tildePath } from '../../../core/format';
import { invoke } from '../../api';
import { ipcErrorMessage } from '../../errors';
import { selectChatItems, useAppStore } from '../../store';
import { Popover } from '../common';
import { GlyphBranch, GlyphChanges, GlyphCode, GlyphCommit, GlyphFolderOpen } from '../common/glyphs';
import { summarizeCounts } from '../Changes/commitMessage';
import { PixelSprite } from '../Subagents/PixelSprite';
import { GlyphBranchPlus, GlyphChevronRight, GlyphFile, GlyphPullRequest } from '../Shell/toolbarGlyphs';
import { collectSources, collectSubagents, countSubagents, type SourceKind, type SubagentStatus } from './collectEnv';
import './Env.css';

export interface EnvPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  thread: Thread;
  project: Project | null;
  homeDir: string | null;
  /** Editor a source opens in (Settings > 기본 에디터, else the first detected editor). */
  editors: EditorInfo[];
  defaultEditor: EditorId | null;
  /** "커밋 또는 푸시" / "풀 리퀘스트 만들기": the existing commit popover and Push + PR confirm. */
  onCommit: () => void;
  onPushPr: () => void;
}

/** Sources shown before "모두 보기". */
const SOURCES_PREVIEW = 5;

const STATUS_LABEL: Record<SubagentStatus, string> = { running: '실행 중', done: '완료', failed: '실패' };
const SOURCE_KIND_LABEL: Record<SourceKind, string> = { mention: '첨부', read: '읽음', edit: '편집' };

/** Editors that open a file (Finder / terminals only reveal folders). */
const FILE_EDITOR_EXCLUDE: readonly EditorId[] = ['finder', 'terminal', 'iterm', 'ghostty'];

/**
 * Environment card (top-right list button): the thread folder's git state and actions, the subagents the thread
 * ran and the files it referenced. Sections without data are left out.
 */
export function EnvPopover({ open, onClose, anchorRef, thread, project, homeDir, editors, defaultEditor, onCommit, onPushPr }: EnvPopoverProps) {
  const items = useAppStore((s) => selectChatItems(s, thread.id));
  const rev = useAppStore((s) => s.gitRevision[thread.id] ?? 0);
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [branchFormOpen, setBranchFormOpen] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setChangesError(null);
    invoke('git:changes', { threadId: thread.id })
      .then((res) => alive && setChanges(res))
      .catch((err: unknown) => alive && setChangesError(ipcErrorMessage(err)));
    return () => {
      alive = false;
    };
  }, [open, thread.id, rev, thread.status]);

  useEffect(() => {
    if (open) return;
    setBranchFormOpen(false);
    setActionError(null);
  }, [open]);

  const subagents = useMemo(() => collectSubagents(items), [items]);
  const subagentCounts = countSubagents(subagents);
  const sources = useMemo(() => collectSources(items, thread.cwd), [items, thread.cwd]);
  const shownSources = showAllSources ? sources : sources.slice(0, SOURCES_PREVIEW);
  const changedPaths = useMemo(() => new Set(changes?.isRepo ? changes.files.map((f) => f.path) : []), [changes]);
  const counts = summarizeCounts(changes?.isRepo ? changes.files : []);
  const fileEditor = useMemo(() => {
    const usable = editors.filter((e) => !FILE_EDITOR_EXCLUDE.includes(e.id));
    return usable.find((e) => e.id === defaultEditor) ?? usable[0] ?? null;
  }, [editors, defaultEditor]);

  const isRepo = changes?.isRepo === true;
  const branch = isRepo ? (changes.branch ?? thread.worktree?.branch ?? null) : null;
  const baseBranch = isRepo ? changes.baseBranch : null;

  const openChanges = () => {
    onClose();
    useAppStore.getState().setPanel('changes');
  };

  const openInFinder = () => {
    setActionError(null);
    invoke('editor:open', { threadId: thread.id, editor: 'finder' }).catch((err: unknown) =>
      setActionError(`Finder에서 열지 못했습니다: ${ipcErrorMessage(err)}`),
    );
  };

  const openSourceInEditor = (path: string) => {
    if (!fileEditor) return;
    setActionError(null);
    invoke('editor:open', { threadId: thread.id, editor: fileEditor.id, path })
      .then(onClose)
      .catch((err: unknown) => setActionError(`${fileEditor.name}에서 열지 못했습니다: ${ipcErrorMessage(err)}`));
  };

  const openSource = (path: string) => {
    if (changedPaths.has(path)) {
      onClose();
      useAppStore.getState().focusChangesFile(thread.id, path);
    } else {
      openSourceInEditor(path);
    }
  };

  const revealTool = (toolUseId: string) => {
    onClose();
    requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(`[data-tool-id="${CSS.escape(toolUseId)}"]`);
      if (!card) return;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.remove('hc-env-flash');
      void card.offsetWidth;
      card.classList.add('hc-env-flash');
      window.setTimeout(() => card.classList.remove('hc-env-flash'), 1400);
    });
  };

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} placement="bottom-end" width={340} aria-label="환경" className="hc-env-pop">
      <div className="hc-env">
        <section className="hc-env__section" aria-labelledby="hc-env-title">
          <h3 className="hc-env__title" id="hc-env-title">
            환경
          </h3>
          {changes && !isRepo ? <p className="hc-env__note">git 저장소가 아닙니다</p> : null}
          {changesError ? (
            <p className="hc-env__error" role="alert">
              {changesError}
            </p>
          ) : null}
          {isRepo ? (
            <button type="button" className="hc-env__row" onClick={openChanges} aria-label={`변경 사항 +${counts.additions} -${counts.deletions}`}>
              <span className="hc-env__icon">
                <GlyphChanges />
              </span>
              <span className="hc-env__label">변경 사항</span>
              <span className="hc-env__stat" data-testid="env-changes-stat">
                <span className="hc-env__add">+{counts.additions}</span>
                <span className="hc-env__del">−{counts.deletions}</span>
              </span>
              <GlyphChevronRight className="hc-env__chev" width={12} height={12} />
            </button>
          ) : null}

          <button
            type="button"
            className="hc-env__row"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen((v) => !v)}
          >
            <span className="hc-env__icon">
              <GlyphBranch />
            </span>
            <span className="hc-env__label">{thread.worktree ? '작업 트리' : '작업 폴더'}</span>
            {branch ? <span className="hc-env__meta">{branch}</span> : null}
            <GlyphChevronRight className={`hc-env__chev${treeOpen ? ' hc-env__chev--open' : ''}`} width={12} height={12} />
          </button>
          {treeOpen ? (
            <div className="hc-env__tree" data-testid="env-worktree">
              <dl className="hc-env__kv">
                <dt>경로</dt>
                <dd title={thread.cwd}>{tildePath(thread.cwd, homeDir)}</dd>
                {branch ? (
                  <>
                    <dt>브랜치</dt>
                    <dd>{branch}</dd>
                  </>
                ) : null}
                {baseBranch ? (
                  <>
                    <dt>기준 브랜치</dt>
                    <dd>{baseBranch}</dd>
                  </>
                ) : null}
                {project ? (
                  <>
                    <dt>프로젝트</dt>
                    <dd title={project.path}>{project.name}</dd>
                  </>
                ) : null}
              </dl>
              <button type="button" className="hc-env__link" onClick={openInFinder}>
                <GlyphFolderOpen width={14} height={14} />
                Finder에서 열기
              </button>
            </div>
          ) : null}

          {thread.worktree && isRepo ? (
            branchFormOpen ? (
              <BranchForm threadId={thread.id} />
            ) : (
              <button type="button" className="hc-env__row" onClick={() => setBranchFormOpen(true)}>
                <span className="hc-env__icon">
                  <GlyphBranchPlus />
                </span>
                <span className="hc-env__label">브랜치 생성</span>
              </button>
            )
          ) : null}

          {isRepo ? (
            <>
              <button
                type="button"
                className="hc-env__row"
                onClick={() => {
                  onClose();
                  onCommit();
                }}
              >
                <span className="hc-env__icon">
                  <GlyphCommit />
                </span>
                <span className="hc-env__label">커밋 또는 푸시</span>
              </button>
              <button
                type="button"
                className="hc-env__row"
                onClick={() => {
                  onClose();
                  onPushPr();
                }}
              >
                <span className="hc-env__icon">
                  <GlyphPullRequest />
                </span>
                <span className="hc-env__label">풀 리퀘스트 만들기</span>
              </button>
            </>
          ) : null}
          {actionError ? (
            <p className="hc-env__error" role="alert">
              {actionError}
            </p>
          ) : null}
        </section>

        {subagents.length > 0 ? (
          <section className="hc-env__section" aria-labelledby="hc-env-agents">
            <h3 className="hc-env__title" id="hc-env-agents">
              하위 에이전트
              <span className="hc-env__summary" data-testid="env-subagents-summary">
                {(['running', 'done', 'failed'] as const)
                  .filter((k) => subagentCounts[k] > 0)
                  .map((k) => `${STATUS_LABEL[k]} ${subagentCounts[k]}`)
                  .join(' · ')}
              </span>
            </h3>
            <ul className="hc-env__list">
              {subagents.map((a) => (
                <li key={a.toolUseId}>
                  <button type="button" className="hc-env__row hc-env__row--agent" onClick={() => revealTool(a.toolUseId)}>
                    <span className="hc-env__avatar" aria-hidden>
                      <PixelSprite
                        type={a.agentType ?? 'general-purpose'}
                        size={24}
                        running={a.status === 'running'}
                        state={a.status === 'running' ? undefined : a.status}
                      />
                    </span>
                    <span className="hc-env__text">
                      <span className="hc-env__label">{a.description ?? a.agentType ?? '하위 에이전트'}</span>
                      {a.description && a.agentType ? <span className="hc-env__sub">{a.agentType}</span> : null}
                    </span>
                    <span className={`hc-env__status hc-env__status--${a.status}`}>{STATUS_LABEL[a.status]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {sources.length > 0 ? (
          <section className="hc-env__section" aria-labelledby="hc-env-sources">
            <h3 className="hc-env__title" id="hc-env-sources">
              소스
            </h3>
            <ul className="hc-env__list">
              {shownSources.map((src) => {
                const changed = changedPaths.has(src.path);
                const slash = src.path.lastIndexOf('/');
                return (
                  <li key={src.path} className="hc-env__source">
                    <button
                      type="button"
                      className="hc-env__row"
                      data-path={src.path}
                      disabled={!changed && !fileEditor}
                      title={changed ? '변경 사항 diff 보기' : fileEditor ? `${fileEditor.name}에서 열기` : '열 수 있는 에디터가 없습니다'}
                      onClick={() => openSource(src.path)}
                    >
                      <span className="hc-env__icon">
                        <GlyphFile />
                      </span>
                      <span className="hc-env__text">
                        <span className="hc-env__label">{src.path.slice(slash + 1)}</span>
                        {slash > 0 ? <span className="hc-env__sub">{src.path.slice(0, slash)}</span> : null}
                      </span>
                      <span className="hc-env__meta">{src.kinds.map((k) => SOURCE_KIND_LABEL[k]).join(' · ')}</span>
                    </button>
                    {changed && fileEditor ? (
                      <button
                        type="button"
                        className="hc-env__mini"
                        aria-label={`${src.path} ${fileEditor.name}에서 열기`}
                        title={`${fileEditor.name}에서 열기`}
                        onClick={() => openSourceInEditor(src.path)}
                      >
                        <GlyphCode width={14} height={14} />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {sources.length > SOURCES_PREVIEW ? (
              <button type="button" className="hc-env__link" onClick={() => setShowAllSources((v) => !v)}>
                {showAllSources ? '접기' : `모두 보기 (${sources.length})`}
              </button>
            ) : null}
          </section>
        ) : null}
      </div>
    </Popover>
  );
}

/** "브랜치 생성": name field, checked as typed; main validates again and runs `git switch -c`. */
function BranchForm({ threadId }: { threadId: string }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  const invalid = trimmed ? branchNameError(trimmed) : null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!trimmed || invalid || busy) return;
      setBusy(true);
      setError(null);
      invoke('git:createBranch', { threadId, name: trimmed })
        .then((res) => {
          if (res.ok) {
            setCreated(res.branch);
            setName('');
            useAppStore.getState().bumpGitRevision(threadId);
          } else {
            setError(res.error);
          }
        })
        .catch((err: unknown) => setError(ipcErrorMessage(err)))
        .finally(() => setBusy(false));
    },
    [trimmed, invalid, busy, threadId],
  );

  return (
    <form className="hc-env__form" onSubmit={submit} aria-label="브랜치 생성">
      <div className="hc-env__form-row">
        <input
          ref={inputRef}
          className="hc-env__input"
          aria-label="새 브랜치 이름"
          placeholder="새 브랜치 이름"
          value={name}
          maxLength={200}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setCreated(null);
          }}
        />
        <button type="submit" className="hc-env__submit" disabled={!trimmed || invalid !== null || busy}>
          {busy ? '만드는 중…' : '만들기'}
        </button>
      </div>
      {invalid || error ? (
        <p className="hc-env__error" role="alert">
          {invalid ?? error}
        </p>
      ) : created ? (
        <p className="hc-env__ok" role="status">
          {created} 브랜치로 전환했습니다
        </p>
      ) : (
        <p className="hc-env__note">현재 작업 트리에서 새 브랜치로 전환합니다</p>
      )}
    </form>
  );
}
