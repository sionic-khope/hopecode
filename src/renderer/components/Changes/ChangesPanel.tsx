import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { GitChangedFile, GitChanges, GitFileDiff, Thread } from '../../../shared/types';
import { invoke } from '../../api';
import { ipcErrorMessage } from '../../errors';
import { useAppStore } from '../../store';
import { Button, Modal } from '../common';
import { DiffView } from '../Chat/DiffView';
import { summarizeCounts } from './commitMessage';
import './Changes.css';

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

export function BranchGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="5.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-2.5 3-5.5 3.9" />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
      <path d="M13.25 2.75v2.5h-2.5" />
    </svg>
  );
}

function RevertGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5.5 3.5 2.75 6.25 5.5 9" />
      <path d="M2.75 6.25h6.5a3.75 3.75 0 0 1 0 7.5H7" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m3.5 2 3 3-3 3" />
    </svg>
  );
}

function EmptyGlyph({ kind }: { kind: 'clean' | 'norepo' | 'error' }) {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {kind === 'clean' ? (
        <path d="m6.5 12.5 3.5 3.5 7.5-8" />
      ) : kind === 'norepo' ? (
        <>
          <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
          <path d="m4 20 16-16" />
        </>
      ) : (
        <>
          <path d="M12 7.5v5.5" />
          <path d="M12 16.5h.01" />
          <circle cx="12" cy="12" r="8.5" />
        </>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface ChangesState {
  data: GitChanges | null;
  loading: boolean;
  error: string | null;
  /** Bumps on every successful load, so expanded diffs refetch. */
  version: number;
}

/**
 * `git:changes` for a thread. Reloads on thread switch, on `gitRevision` bumps and when a running turn ends.
 * The previous result stays on screen while a reload is in flight (no flash); stale responses are dropped.
 */
function useGitChanges(thread: Thread) {
  const rev = useAppStore((s) => s.gitRevision[thread.id] ?? 0);
  const [state, setState] = useState<ChangesState>({ data: null, loading: true, error: null, version: 0 });
  const reqId = useRef(0);
  const shownThread = useRef(thread.id);

  const reload = useCallback(() => {
    const id = ++reqId.current;
    const threadId = thread.id;
    const switched = shownThread.current !== threadId;
    shownThread.current = threadId;
    setState((s) => ({ ...s, data: switched ? null : s.data, loading: true, error: null }));
    invoke('git:changes', { threadId })
      .then((data) => {
        if (id !== reqId.current) return;
        setState((s) => ({ data, loading: false, error: null, version: s.version + 1 }));
      })
      .catch((err: unknown) => {
        if (id !== reqId.current) return;
        setState((s) => ({ ...s, loading: false, error: ipcErrorMessage(err) }));
      });
  }, [thread.id]);

  useEffect(() => {
    reload();
  }, [reload, rev]);

  const prevStatus = useRef(thread.status);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = thread.status;
    if (prev === 'running' && thread.status !== 'running') reload();
  }, [thread.status, reload]);

  return { ...state, reload };
}

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return i >= 0 ? { dir: path.slice(0, i + 1), name: path.slice(i + 1) } : { dir: '', name: path };
}

const STATUS_LABEL: Record<GitChangedFile['status'], string> = {
  M: '수정됨',
  A: '추가됨',
  D: '삭제됨',
  R: '이름 변경됨',
  U: '충돌',
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

export function StatusBadge({ file }: { file: Pick<GitChangedFile, 'status' | 'untracked'> }) {
  const label = file.untracked ? '추적되지 않음' : STATUS_LABEL[file.status];
  return (
    <span
      className={`hc-changes__badge hc-changes__badge--${file.status}${file.untracked ? ' hc-changes__badge--untracked' : ''}`}
      title={label}
      aria-label={label}
      role="img"
    >
      {file.status}
    </span>
  );
}

function LineStat({ additions, deletions, binary = false }: { additions: number; deletions: number; binary?: boolean }) {
  if (binary) return <span className="hc-changes__stat hc-changes__stat--bin">bin</span>;
  return (
    <span className="hc-changes__stat" aria-label={`${additions}줄 추가, ${deletions}줄 삭제`}>
      <span className="hc-changes__add">+{additions}</span>
      <span className="hc-changes__del">−{deletions}</span>
    </span>
  );
}

type DiffState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; diff: GitFileDiff } | { kind: 'error'; message: string };

function FileRow({
  threadId,
  file,
  open,
  version,
  onToggle,
  onRevert,
}: {
  threadId: string;
  file: GitChangedFile;
  open: boolean;
  version: number;
  onToggle: () => void;
  onRevert: () => void;
}) {
  const bodyId = useId();
  const [diff, setDiff] = useState<DiffState>({ kind: 'idle' });
  const loadedVersion = useRef(-1);

  // Lazy: fetch when first opened, and again after the list reloads while open.
  useEffect(() => {
    if (!open || loadedVersion.current === version) return;
    loadedVersion.current = version;
    let alive = true;
    setDiff((d) => (d.kind === 'ready' ? d : { kind: 'loading' }));
    invoke('git:fileDiff', { threadId, path: file.path })
      .then((res) => alive && setDiff({ kind: 'ready', diff: res }))
      .catch((err: unknown) => alive && setDiff({ kind: 'error', message: ipcErrorMessage(err) }));
    return () => {
      alive = false;
      // An interrupted fetch must run again on the next open.
      if (loadedVersion.current === version) loadedVersion.current = -1;
    };
  }, [open, version, threadId, file.path]);

  const { dir, name } = splitPath(file.path);
  const renamedFrom = file.status === 'R' && file.oldPath ? file.oldPath : null;

  return (
    <li className={`hc-changes__item${open ? ' hc-changes__item--open' : ''}`}>
      <div className="hc-changes__rowline">
        <button
          type="button"
          className="hc-changes__file"
          data-path={file.path}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="hc-changes__chev">
            <ChevronGlyph />
          </span>
          <StatusBadge file={file} />
          <span className="hc-changes__path" title={renamedFrom ? `${renamedFrom} → ${file.path}` : file.path}>
            <span className="hc-changes__name">{name}</span>
            {dir || renamedFrom ? (
              <span className="hc-changes__dir">{renamedFrom ? `← ${renamedFrom}` : dir.replace(/\/$/, '')}</span>
            ) : null}
          </span>
          <LineStat additions={file.additions} deletions={file.deletions} binary={file.binary} />
        </button>
        <button
          type="button"
          className="hc-changes__revert"
          aria-label={`${file.path} 되돌리기`}
          title="되돌리기"
          onClick={onRevert}
        >
          <RevertGlyph />
        </button>
      </div>
      <div className="hc-changes__drawer" id={bodyId} inert={!open}>
        <div className="hc-changes__drawer-inner">
          <div className="hc-changes__diff">
            <DiffBody state={diff} binary={file.binary} />
          </div>
        </div>
      </div>
    </li>
  );
}

function DiffBody({ state, binary }: { state: DiffState; binary: boolean }) {
  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <div className="hc-changes__diffnote" aria-live="polite">
        <span className="hc-changes__dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        불러오는 중…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="hc-changes__diffnote hc-changes__diffnote--error" role="alert">
        {state.message}
      </div>
    );
  }
  if (binary || state.diff.binary) return <div className="hc-changes__diffnote">바이너리 파일이라 내용을 표시하지 않아요.</div>;
  if (state.diff.hunks.length === 0) return <div className="hc-changes__diffnote">표시할 줄 단위 변경이 없어요.</div>;
  return <DiffView patch={state.diff.hunks} />;
}

function EmptyState({ kind, title, sub, action }: { kind: 'clean' | 'norepo' | 'error'; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className={`hc-changes__empty hc-changes__empty--${kind}`}>
      <div className="hc-changes__empty-icon">
        <EmptyGlyph kind={kind} />
      </div>
      <p className="hc-changes__empty-title">{title}</p>
      {sub ? <p className="hc-changes__empty-sub">{sub}</p> : null}
      {action}
    </div>
  );
}

function SkeletonRows() {
  return (
    <ul className="hc-changes__list hc-changes__list--skeleton" aria-hidden>
      {[62, 44, 70].map((w) => (
        <li key={w} className="hc-changes__skeleton">
          <span className="hc-changes__skeleton-badge" />
          <span className="hc-changes__skeleton-bar" style={{ width: `${w}%` }} />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Revert confirmation
// ---------------------------------------------------------------------------

function RevertModal({ threadId, file, onClose }: { threadId: string; file: GitChangedFile | null; onClose: () => void }) {
  const bumpGitRevision = useAppStore((s) => s.bumpGitRevision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [file]);

  const confirm = () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    invoke('git:revertFile', { threadId, path: file.path })
      .then((res) => {
        if (res.ok) {
          bumpGitRevision(threadId);
          onClose();
        } else {
          setError(res.error);
          setBusy(false);
        }
      })
      .catch((err: unknown) => {
        setError(ipcErrorMessage(err));
        setBusy(false);
      });
  };

  return (
    <Modal
      open={file !== null}
      onClose={onClose}
      role="alertdialog"
      title="변경 사항을 되돌릴까요?"
      subtitle="되돌린 뒤에는 다시 복구할 수 없어요."
      width={420}
      dismissible={!busy}
      icon={
        <span className="hc-changes__modal-icon hc-changes__modal-icon--crit">
          <RevertGlyph />
        </span>
      }
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy} data-autofocus>
            {busy ? '되돌리는 중…' : '되돌리기'}
          </Button>
        </>
      }
    >
      {file ? (
        <div className="hc-changes__confirm">
          <div className="hc-changes__confirm-file">
            <StatusBadge file={file} />
            <code>{file.path}</code>
          </div>
          <p className="hc-changes__confirm-text">
            {file.untracked
              ? '아직 git이 추적하지 않는 새 파일이라, 되돌리면 파일이 삭제됩니다.'
              : '이 파일의 모든 변경 사항이 마지막 커밋 상태로 돌아갑니다.'}
          </p>
          {error ? (
            <p className="hc-changes__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/** Right-panel "변경사항" tab: branch, totals and a per-file list with inline diffs and revert. */
export function ChangesPanel({ thread }: { thread: Thread }) {
  const { data, loading, error, version, reload } = useGitChanges(thread);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [revertTarget, setRevertTarget] = useState<GitChangedFile | null>(null);

  useEffect(() => {
    setExpanded(new Set());
    setRevertTarget(null);
  }, [thread.id]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const files = data?.isRepo ? data.files : [];
  const totals = summarizeCounts(files);

  // "소스" in the environment popover: expand the file and bring it into view, once per request.
  const focus = useAppStore((s) => (s.changesFocus?.threadId === thread.id ? s.changesFocus : null));
  const appliedFocus = useRef(0);
  useEffect(() => {
    if (!focus || appliedFocus.current === focus.nonce || !files.some((f) => f.path === focus.path)) return;
    appliedFocus.current = focus.nonce;
    setExpanded((prev) => new Set(prev).add(focus.path));
    requestAnimationFrame(() =>
      document
        .querySelector(`.hc-changes__file[data-path="${CSS.escape(focus.path)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }, [focus, files]);

  let body: ReactNode;
  if (!data) {
    body = error ? (
      <EmptyState
        kind="error"
        title="변경 사항을 불러오지 못했어요"
        sub={error}
        action={
          <Button variant="secondary" size="sm" onClick={reload}>
            다시 시도
          </Button>
        }
      />
    ) : (
      <SkeletonRows />
    );
  } else if (!data.isRepo) {
    body = <EmptyState kind="norepo" title="git 저장소가 아닙니다" sub="이 폴더는 git으로 관리되고 있지 않아 변경 사항을 추적할 수 없어요." />;
  } else if (files.length === 0) {
    body = <EmptyState kind="clean" title="변경 사항이 없습니다" sub="에이전트가 파일을 바꾸면 여기에 표시돼요." />;
  } else {
    body = (
      <ul className="hc-changes__list">
        {files.map((f) => (
          <FileRow
            key={f.path}
            threadId={thread.id}
            file={f}
            open={expanded.has(f.path)}
            version={version}
            onToggle={() => toggle(f.path)}
            onRevert={() => setRevertTarget(f)}
          />
        ))}
      </ul>
    );
  }

  const branch = data?.isRepo ? data.branch ?? thread.worktree?.branch ?? null : null;
  const baseBranch = data?.isRepo && thread.worktree ? data.baseBranch : null;
  const ahead = data?.isRepo ? data.ahead : 0;

  return (
    <section className="hc-changes" aria-label="변경사항" data-testid="changes-panel" aria-busy={loading}>
      <header className="hc-changes__header">
        <div className="hc-changes__branchline">
          {branch ? (
            <span className="hc-changes__branch" title={branch}>
              <BranchGlyph />
              <span className="hc-changes__branch-name">{branch}</span>
            </span>
          ) : null}
          {baseBranch ? (
            <span className="hc-changes__base" title={`${baseBranch}에서 분기`}>
              ← {baseBranch}
            </span>
          ) : null}
          {ahead > 0 ? <span className="hc-changes__ahead">커밋 {ahead}개 앞섬</span> : null}
          <Button
            variant="plain"
            size="sm"
            icon
            className={`hc-changes__refresh${loading ? ' hc-changes__refresh--spin' : ''}`}
            aria-label="새로고침"
            title="새로고침"
            onClick={reload}
          >
            <RefreshGlyph />
          </Button>
        </div>
        {files.length > 0 ? (
          <div className="hc-changes__totals">
            <span className="hc-changes__count">파일 {totals.files}개</span>
            <LineStat additions={totals.additions} deletions={totals.deletions} />
          </div>
        ) : null}
        {data && error ? (
          <p className="hc-changes__error" role="alert">
            {error}
          </p>
        ) : null}
      </header>
      <div className="hc-changes__body">{body}</div>
      <RevertModal threadId={thread.id} file={revertTarget} onClose={() => setRevertTarget(null)} />
    </section>
  );
}
