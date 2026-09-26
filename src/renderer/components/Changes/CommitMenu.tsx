import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { GitChanges, GitRemoteInfo, Thread } from '../../../shared/types';
import { invoke } from '../../api';
import { ipcErrorMessage } from '../../errors';
import { useAppStore } from '../../store';
import { Button, Modal, Popover } from '../common';
import { BranchGlyph } from './ChangesPanel';
import { autoCommitMessage, summarizeCounts } from './commitMessage';
import './Changes.css';

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

function CommitGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M1.5 8h3.75M10.75 8h3.75" />
    </svg>
  );
}

function ChevronDownGlyph() {
  return (
    <svg width={9} height={9} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m2.5 4 2.5 2.5L7.5 4" />
    </svg>
  );
}

function MergeGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="10" r="1.75" />
      <path d="M4.5 5.25v5.5M4.5 5.5c0 3 2.5 4.5 5.25 4.5" />
    </svg>
  );
}

function PullRequestGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="12.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 10.75V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" />
    </svg>
  );
}

function SparkGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden>
      <path d="M8 1.75 9.4 6.1l4.35 1.4-4.35 1.4L8 13.25 6.6 8.9 2.25 7.5 6.6 6.1z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Outcome = { kind: 'ok'; text: string } | { kind: 'error'; text: string } | null;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function subjectOf(message: string): string {
  return message.split('\n')[0] ?? '';
}

function bodyOf(message: string): string {
  const i = message.indexOf('\n\n');
  return i >= 0 ? message.slice(i + 2) : '';
}

/** Why "Push + PR 만들기" is unavailable, or null when it can run. */
function pushBlocker(info: GitRemoteInfo | null, loading: boolean): string | null {
  if (!info) return loading ? '저장소 정보를 확인하는 중…' : '저장소 정보를 불러오지 못했어요';
  if (!info.remote) return 'remote가 없습니다';
  if (!info.ghAvailable) return 'gh CLI가 설치되어 있지 않습니다';
  if (!info.branch) return '현재 브랜치를 확인할 수 없어요';
  if (!info.baseBranch) return 'PR 기준 브랜치가 없어요';
  return null;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function MergeModal({
  open,
  onClose,
  threadId,
  branch,
  baseBranch,
}: {
  open: boolean;
  onClose: () => void;
  threadId: string;
  branch: string;
  baseBranch: string | null;
}) {
  const bumpGitRevision = useAppStore((s) => s.bumpGitRevision);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setOutcome(null);
    }
  }, [open]);

  const merge = () => {
    setBusy(true);
    setOutcome(null);
    invoke('git:merge', { threadId })
      .then((res) => {
        if (res.ok) {
          setOutcome({ kind: 'ok', text: `병합했습니다 → ${res.into}` });
          bumpGitRevision(threadId);
        } else {
          setOutcome({ kind: 'error', text: res.error });
        }
      })
      .catch((err: unknown) => setOutcome({ kind: 'error', text: ipcErrorMessage(err) }))
      .finally(() => setBusy(false));
  };

  const done = outcome?.kind === 'ok';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="원래 브랜치에 병합할까요?"
      subtitle="이 스레드의 작업 브랜치를 프로젝트 브랜치로 합칩니다."
      icon={<MergeGlyph />}
      width={440}
      dismissible={!busy}
      actions={
        done ? (
          <Button variant="primary" onClick={onClose} data-autofocus>
            닫기
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              취소
            </Button>
            <Button variant="primary" onClick={merge} disabled={busy} data-autofocus>
              {busy ? '병합하는 중…' : '병합'}
            </Button>
          </>
        )
      }
    >
      <dl className="hc-kv">
        <dt>브랜치</dt>
        <dd>
          {branch} → {baseBranch ?? '원래 브랜치'}
        </dd>
      </dl>
      <p className="hc-commit__note">커밋하지 않은 변경 사항이 있거나 충돌이 생기면 병합하지 않고 멈춰요.</p>
      <OutcomeLine outcome={outcome} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Push + PR
// ---------------------------------------------------------------------------

function PushPrModal({
  open,
  onClose,
  threadId,
  info,
  initialTitle,
  initialBody,
}: {
  open: boolean;
  onClose: () => void;
  threadId: string;
  info: GitRemoteInfo | null;
  initialTitle: string;
  initialBody: string;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle);
    setBody(initialBody);
    setBusy(false);
    setOutcome(null);
    setPrUrl(null);
    // Prefill only when the modal opens; later prop changes must not clobber edits.
  }, [open]);

  const submit = () => {
    setBusy(true);
    setOutcome(null);
    invoke('git:pushPr', { threadId, title: title.trim(), body })
      .then((res) => {
        if (res.ok) {
          setPrUrl(res.url);
          setOutcome({ kind: 'ok', text: res.url ? 'PR을 만들었습니다' : 'Push했습니다. PR 주소는 확인하지 못했어요.' });
        } else {
          setOutcome({ kind: 'error', text: res.error });
        }
      })
      .catch((err: unknown) => setOutcome({ kind: 'error', text: ipcErrorMessage(err) }))
      .finally(() => setBusy(false));
  };

  const done = outcome?.kind === 'ok';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Push하고 PR을 만들까요?"
      subtitle="외부에 게시되는 작업입니다"
      icon={<PullRequestGlyph />}
      width={500}
      dismissible={!busy}
      actions={
        done ? (
          <Button variant="primary" onClick={onClose} data-autofocus>
            닫기
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              취소
            </Button>
            <Button variant="primary" onClick={submit} disabled={busy || title.trim() === ''}>
              {busy ? '만드는 중…' : 'Push + PR 만들기'}
            </Button>
          </>
        )
      }
    >
      <dl className="hc-kv">
        <dt>remote</dt>
        <dd>
          {info?.remote ?? '-'}
          {info?.remoteUrl ? <span className="hc-commit__dim"> · {info.remoteUrl}</span> : null}
        </dd>
        <dt>브랜치</dt>
        <dd>
          {info?.branch ?? '-'} → {info?.baseBranch ?? '-'}
        </dd>
      </dl>
      {done ? (
        <div className="hc-commit__result">
          <OutcomeLine outcome={outcome} />
          {prUrl ? (
            <code className="hc-commit__url" aria-label="PR 주소">
              {prUrl}
            </code>
          ) : null}
        </div>
      ) : (
        <div className="hc-commit__fields">
          <label className="hc-commit__field">
            <span className="hc-commit__label">PR 제목</span>
            <input
              className="hc-commit__input"
              value={title}
              maxLength={200}
              disabled={busy}
              data-autofocus
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="hc-commit__field">
            <span className="hc-commit__label">설명</span>
            <textarea
              className="hc-commit__textarea hc-commit__textarea--tall"
              value={body}
              disabled={busy}
              rows={6}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <OutcomeLine outcome={outcome} />
        </div>
      )}
    </Modal>
  );
}

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null;
  return outcome.kind === 'ok' ? (
    <p className="hc-commit__ok" role="status">
      {outcome.text}
    </p>
  ) : (
    <p className="hc-changes__error" role="alert">
      {outcome.text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Commit menu
// ---------------------------------------------------------------------------

/** Opens the commit popover (`commit`) or goes straight to the Push + PR confirm (`push`), once per `nonce`. */
export interface CommitMenuRequest {
  kind: 'commit' | 'push';
  nonce: number;
}

export interface CommitMenuProps {
  thread: Thread;
  /**
   * Anchor owned by the caller (the environment button): no "커밋" trigger is rendered and the popover opens
   * only through `request`.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  request?: CommitMenuRequest | null;
}

/** "커밋" popover: commit (with an auto message), merge back, push + PR. */
export function CommitMenu({ thread, anchorRef, request = null }: CommitMenuProps) {
  const bumpGitRevision = useAppStore((s) => s.bumpGitRevision);
  const rev = useAppStore((s) => s.gitRevision[thread.id] ?? 0);
  const ownTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = anchorRef ?? ownTriggerRef;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<'merge' | 'push' | null>(null);
  const [message, setMessage] = useState('');
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [remote, setRemote] = useState<GitRemoteInfo | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [prDraft, setPrDraft] = useState({ title: '', body: '' });

  // Thread switch: drop everything tied to the previous thread.
  useEffect(() => {
    setOpen(false);
    setModal(null);
    setMessage('');
    setChanges(null);
    setRemote(null);
    setOutcome(null);
  }, [thread.id]);

  const loadChanges = useCallback(async (): Promise<GitChanges | null> => {
    try {
      const res = await invoke('git:changes', { threadId: thread.id });
      setChanges(res);
      return res;
    } catch (err) {
      setOutcome({ kind: 'error', text: ipcErrorMessage(err) });
      return null;
    }
  }, [thread.id]);

  // While open: fresh changes (again after any commit/merge/revert elsewhere).
  useEffect(() => {
    if (open) void loadChanges();
  }, [open, rev, loadChanges]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRemoteLoading(true);
    invoke('git:remoteInfo', { threadId: thread.id })
      .then((info) => alive && setRemote(info))
      .catch(() => alive && setRemote(null))
      .finally(() => alive && setRemoteLoading(false));
    return () => {
      alive = false;
    };
  }, [open, thread.id]);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const isRepo = changes?.isRepo ?? true;
  const hasChanges = changes?.isRepo === true && changes.dirty;
  const counts = summarizeCounts(changes?.isRepo ? changes.files : []);
  // The checked-out branch (it changes after "브랜치 생성"); the worktree's own until git answered.
  const branch = (changes?.isRepo ? changes.branch : null) ?? thread.worktree?.branch ?? null;
  const baseBranch = changes?.isRepo ? changes.baseBranch : (remote?.baseBranch ?? null);
  const canCommit = hasChanges && message.trim() !== '' && !committing;
  const blocker = pushBlocker(remote, remoteLoading);

  const generate = async () => {
    setGenerating(true);
    setOutcome(null);
    const fresh = await loadChanges();
    setGenerating(false);
    if (!fresh?.isRepo) return;
    const auto = autoCommitMessage(fresh.files);
    if (auto) {
      setMessage(auto);
      textareaRef.current?.focus();
    } else {
      setOutcome({ kind: 'error', text: '커밋할 변경 사항이 없어요.' });
    }
  };

  const commit = () => {
    if (!canCommit) return;
    setCommitting(true);
    setOutcome(null);
    invoke('git:commit', { threadId: thread.id, message: message.trim() })
      .then((res) => {
        if (res.ok) {
          setOutcome({ kind: 'ok', text: `커밋했습니다 · ${shortSha(res.sha)}` });
          setMessage('');
          bumpGitRevision(thread.id);
        } else {
          setOutcome({ kind: 'error', text: res.error });
        }
      })
      .catch((err: unknown) => setOutcome({ kind: 'error', text: ipcErrorMessage(err) }))
      .finally(() => setCommitting(false));
  };

  const onTextareaKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit();
    }
  };

  /** Close the popover and hand focus to the trigger first, so the modal returns focus there. */
  const openModal = (kind: 'merge' | 'push') => {
    if (kind === 'push') {
      const auto = autoCommitMessage(changes?.isRepo ? changes.files : []);
      setPrDraft({ title: subjectOf(auto) || (remote?.branch ?? ''), body: bodyOf(auto) });
    }
    setOpen(false);
    triggerRef.current?.focus({ focusVisible: false } as FocusOptions);
    setModal(kind);
  };

  // External request (environment popover). `push` needs the remote first: the confirm opens when nothing
  // blocks it, otherwise the popover shows why.
  const handledRequest = useRef(request?.nonce ?? 0);
  useEffect(() => {
    if (!request || handledRequest.current === request.nonce) return;
    handledRequest.current = request.nonce;
    setOutcome(null);
    if (request.kind === 'commit') {
      setOpen(true);
      return;
    }
    let alive = true;
    void Promise.all([loadChanges(), invoke('git:remoteInfo', { threadId: thread.id }).catch(() => null)]).then(([fresh, info]) => {
      if (!alive) return;
      setRemote(info);
      if (pushBlocker(info, false) !== null) {
        setOpen(true);
        return;
      }
      const auto = autoCommitMessage(fresh?.isRepo ? fresh.files : []);
      setPrDraft({ title: subjectOf(auto) || (info?.branch ?? ''), body: bodyOf(auto) });
      setModal('push');
    });
    return () => {
      alive = false;
    };
  }, [request, loadChanges, thread.id]);

  return (
    <>
      {anchorRef ? null : (
        <button
          ref={ownTriggerRef}
          type="button"
          className="hc-toolbar-btn hc-toolbar-btn--split hc-commit-trigger"
          aria-label="커밋"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="커밋"
          onClick={() => {
            if (!open) setOutcome(null);
            setOpen((v) => !v);
          }}
        >
          <CommitGlyph />
          <span className="hc-commit-trigger__label">커밋</span>
          <span className="hc-commit-trigger__chev">
            <ChevronDownGlyph />
          </span>
        </button>
      )}

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        placement="bottom-end"
        width={360}
        aria-label="커밋"
        className="hc-commit-pop"
      >
        <div className="hc-commit">
          <div className="hc-commit__head">
            <h3 className="hc-commit__title">변경 사항 커밋</h3>
            {branch ? (
              <span className="hc-changes__branch hc-changes__branch--sm" title={branch}>
                <BranchGlyph size={11} />
                <span className="hc-changes__branch-name">{branch}</span>
              </span>
            ) : null}
          </div>

          <div className="hc-commit__summary" aria-live="polite">
            {!changes ? (
              <span className="hc-commit__dim">변경 사항을 확인하는 중…</span>
            ) : !isRepo ? (
              <span className="hc-commit__dim">git 저장소가 아닙니다</span>
            ) : hasChanges ? (
              <>
                <span>파일 {counts.files}개</span>
                <span className="hc-changes__add">+{counts.additions}</span>
                <span className="hc-changes__del">−{counts.deletions}</span>
              </>
            ) : (
              <span className="hc-commit__dim">변경 사항 없음</span>
            )}
          </div>

          <textarea
            ref={textareaRef}
            className="hc-commit__textarea"
            aria-label="커밋 메시지"
            placeholder="무엇을 바꿨나요?"
            rows={4}
            value={message}
            disabled={committing || !isRepo}
            onChange={(e) => {
              setMessage(e.target.value);
              if (outcome?.kind === 'ok') setOutcome(null);
            }}
            onKeyDown={onTextareaKey}
          />

          <div className="hc-commit__row">
            <Button variant="plain" size="sm" onClick={() => void generate()} disabled={generating || committing || !isRepo}>
              <SparkGlyph />
              {generating ? '만드는 중…' : '자동 생성'}
            </Button>
            <span className="hc-commit__spacer" />
            <span className="hc-commit__hint" aria-hidden>
              ⌘⏎
            </span>
            <Button variant="primary" size="sm" onClick={commit} disabled={!canCommit} aria-keyshortcuts="Meta+Enter">
              {committing ? '커밋하는 중…' : '커밋'}
            </Button>
          </div>

          <OutcomeLine outcome={outcome} />

          <div className="hc-mnu__sep hc-commit__sep" role="separator" />

          <div className="hc-commit__actions">
            {thread.worktree ? (
              <button type="button" className="hc-mnu__item" onClick={() => openModal('merge')}>
                <span className="hc-mnu__icon">
                  <MergeGlyph />
                </span>
                <span className="hc-mnu__text">
                  <span className="hc-mnu__label">원래 브랜치에 병합</span>
                  <span className="hc-mnu__desc">
                    {branch ?? thread.worktree.branch} → {baseBranch ?? '원래 브랜치'}
                  </span>
                </span>
              </button>
            ) : null}
            <button type="button" className="hc-mnu__item" disabled={blocker !== null} onClick={() => openModal('push')}>
              <span className="hc-mnu__icon">
                <PullRequestGlyph />
              </span>
              <span className="hc-mnu__text">
                <span className="hc-mnu__label">Push + PR 만들기</span>
                <span className="hc-mnu__desc">
                  {blocker ?? `${remote?.branch} → ${remote?.baseBranch}`}
                </span>
              </span>
            </button>
          </div>
        </div>
      </Popover>

      {thread.worktree ? (
        <MergeModal
          open={modal === 'merge'}
          onClose={() => setModal(null)}
          threadId={thread.id}
          branch={branch ?? thread.worktree.branch}
          baseBranch={baseBranch}
        />
      ) : null}
      <PushPrModal
        open={modal === 'push'}
        onClose={() => setModal(null)}
        threadId={thread.id}
        info={remote}
        initialTitle={prDraft.title}
        initialBody={prDraft.body}
      />
    </>
  );
}
