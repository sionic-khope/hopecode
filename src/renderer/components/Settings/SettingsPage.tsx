import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_NEW_TASK_TEMPLATE,
  EFFORT_LEVELS,
  IDLE_CLOSE_MAX_MINUTES,
  NEW_TASK_TEMPLATE_MAX_CHARS,
  UI_PERMISSION_MODES,
  USAGE_POLL_MAX_SEC,
  USAGE_POLL_MIN_SEC,
} from '../../../shared/constants';
import type {
  Account,
  AppSettings,
  EditorId,
  EditorInfo,
  EffortLevel,
  ModelOption,
  SettingsPatch,
  SharedConfigStatus,
  SharedEntryState,
  UiPermissionMode,
} from '../../../shared/types';
import { modelMenuLabel } from '../../../core/modelDisplay';
import { tildePath } from '../../../core/format';
import { Button, Menu, Modal, Segmented, Switch, type MenuSection } from '../common';
import { GlyphChevronDown, GlyphFolderOpen, GlyphRefresh } from '../common/glyphs';
import { EFFORT_LABEL, PERMISSION_MODE_LABEL } from '../Chat/ComposerControls';
import './Settings.css';

export interface SettingsPageProps {
  settings: AppSettings;
  models: ModelOption[];
  accounts: Account[];
  /** Archived threads (데이터 > 모두 삭제). */
  archivedCount: number;
  homeDir: string | null;
  /** What `default` runs as ("Fable 5.1"). */
  defaultModelLabel: string;
  onUpdate: (patch: SettingsPatch) => Promise<unknown>;
  onDeleteArchived: () => Promise<number>;
  onOpenDataFolder: () => Promise<void>;
  loadDataDir: () => Promise<string>;
  loadEditors: () => Promise<EditorInfo[]>;
  loadSharedStatus: () => Promise<SharedConfigStatus>;
  relinkShared: () => Promise<SharedConfigStatus>;
  onBack: () => void;
}

const DEFAULT_MODES = UI_PERMISSION_MODES.filter((m): m is Exclude<UiPermissionMode, 'bypassPermissions'> => m !== 'bypassPermissions');

const STATE_LABEL: Record<SharedEntryState, string> = {
  linked: '연결됨',
  'not-linked': '연결 안 됨',
  broken: '끊어짐',
  conflict: '별도 파일',
};

/** Seconds -> `1분 30초` style. */
export function formatInterval(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}초`;
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}

/**
 * 설정 (⌘,): macOS-style section cards. Every control writes through `settings:update` (validated in main, which
 * also applies it: poll interval, rotation, worktrees, new-chat defaults); the page shows the stored value.
 */
export function SettingsPage({
  settings,
  models,
  accounts,
  archivedCount,
  homeDir,
  defaultModelLabel,
  onUpdate,
  onDeleteArchived,
  onOpenDataFolder,
  loadDataDir,
  loadEditors,
  loadSharedStatus,
  relinkShared,
  onBack,
}: SettingsPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [shared, setShared] = useState<SharedConfigStatus | null>(null);
  const [relinking, setRelinking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [idleDraft, setIdleDraft] = useState(String(settings.idleCloseMinutes));
  const [pollDraft, setPollDraft] = useState(settings.usagePollIntervalSec);
  const [templateDraft, setTemplateDraft] = useState(settings.newTaskTemplate);

  useEffect(() => setIdleDraft(String(settings.idleCloseMinutes)), [settings.idleCloseMinutes]);
  useEffect(() => setPollDraft(settings.usagePollIntervalSec), [settings.usagePollIntervalSec]);
  useEffect(() => setTemplateDraft(settings.newTaskTemplate), [settings.newTaskTemplate]);

  useEffect(() => {
    let live = true;
    void loadDataDir().then((d) => live && setDataDir(d)).catch(() => {});
    void loadEditors().then((e) => live && setEditors(e)).catch(() => {});
    void loadSharedStatus().then((s) => live && setShared(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, [loadDataDir, loadEditors, loadSharedStatus]);

  const save = (patch: SettingsPatch) => {
    setError(null);
    void onUpdate(patch).catch((err: unknown) => setError(`설정을 저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`));
  };

  const commitIdle = () => {
    const n = Number(idleDraft);
    if (!Number.isInteger(n) || n < 0 || n > IDLE_CLOSE_MAX_MINUTES) {
      setIdleDraft(String(settings.idleCloseMinutes));
      return;
    }
    if (n !== settings.idleCloseMinutes) save({ idleCloseMinutes: n });
  };

  const commitTemplate = () => {
    // Mirrors the core validation (core/settings.ts): blank falls back to the default. Applied to the local draft
    // right away so the textarea reflects it even when that also happens to be what `settings` already held (the
    // sync effect below only fires on a *value* change, which a round-trip to the same default would not be).
    const next = templateDraft.trim().length === 0 ? DEFAULT_NEW_TASK_TEMPLATE : templateDraft;
    setTemplateDraft(next);
    if (templateDraft !== settings.newTaskTemplate) save({ newTaskTemplate: templateDraft });
  };
  const resetTemplate = () => {
    setTemplateDraft(DEFAULT_NEW_TASK_TEMPLATE);
    save({ newTaskTemplate: DEFAULT_NEW_TASK_TEMPLATE });
  };

  const modelOptions = models.length > 0 ? models : [{ value: 'default', label: 'Default' }];

  return (
    <div className="hc-settings" data-testid="settings">
      <header className="hc-settings__header">
        <Button variant="plain" size="sm" icon aria-label="뒤로" onClick={onBack}>
          <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10 3.5 5 8l5 4.5" />
          </svg>
        </Button>
        <div>
          <h1 className="hc-settings__title">설정</h1>
          <p className="hc-settings__lede">새 채팅의 기본값, 계정 전환, 공유 설정과 데이터를 관리합니다.</p>
        </div>
      </header>
      {error ? (
        <div className="hc-settings__error" role="alert">
          {error}
        </div>
      ) : null}

      <Section title="일반" description="새 채팅을 시작할 때 쓰는 값입니다. 이미 시작된 채팅은 바뀌지 않습니다.">
        <Row label="기본 모델" hint={`기본은 지금 ${defaultModelLabel}로 실행됩니다`}>
          <SelectMenu
            label="기본 모델"
            value={settings.defaultModel}
            options={modelOptions.map((m) => ({ value: m.value, label: modelMenuLabel(m.value, modelOptions, defaultModelLabel) }))}
            onChange={(defaultModel) => save({ defaultModel })}
          />
        </Row>
        <Row label="기본 effort" hint="모델의 추론 깊이">
          <Segmented<'auto' | EffortLevel>
            aria-label="기본 effort"
            size="sm"
            value={settings.defaultEffort ?? 'auto'}
            options={[{ value: 'auto', label: '자동' }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: e === 'xhigh' ? 'XHigh' : EFFORT_LABEL[e] }))]}
            onChange={(v) => save({ defaultEffort: v === 'auto' ? null : v })}
          />
        </Row>
        <Row label="기본 권한 모드" hint="전체 액세스는 채팅마다 확인을 거쳐 켭니다">
          <Segmented
            aria-label="기본 권한 모드"
            size="sm"
            value={settings.defaultPermissionMode === 'bypassPermissions' ? 'default' : settings.defaultPermissionMode}
            options={DEFAULT_MODES.map((m) => ({ value: m, label: PERMISSION_MODE_LABEL[m] }))}
            onChange={(defaultPermissionMode) => save({ defaultPermissionMode })}
          />
        </Row>
        <Row
          label="새 스레드마다 worktree 만들기"
          hint={
            settings.useWorktree
              ? 'git 저장소에서는 스레드마다 hopecode/<id> 브랜치의 worktree에서 작업합니다'
              : '프로젝트 폴더에서 직접 작업합니다. 여러 스레드가 같은 파일을 바꿀 수 있어요'
          }
        >
          <Switch size="md" checked={settings.useWorktree} aria-label="새 스레드마다 worktree 만들기" onChange={(useWorktree) => save({ useWorktree })} />
        </Row>
        <Row label="유휴 세션 종료" hint="이 시간 동안 입력이 없으면 세션을 닫습니다. 다음 메시지에서 이어집니다 (0 = 닫지 않음)">
          <span className="hc-settings__number">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={IDLE_CLOSE_MAX_MINUTES}
              step={1}
              aria-label="유휴 세션 종료 (분)"
              value={idleDraft}
              onChange={(e) => setIdleDraft(e.target.value)}
              onBlur={commitIdle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
            <span>분</span>
          </span>
        </Row>
        <Row label="기본 에디터" hint="대화 화면의 ‘에디터에서 열기’ 버튼이 여는 앱">
          <SelectMenu<EditorId | 'auto'>
            label="기본 에디터"
            value={settings.defaultEditor ?? 'auto'}
            options={[
              { value: 'auto', label: editors[0] ? `자동 (${editors[0].name})` : '자동' },
              ...editors.map((e) => ({ value: e.id, label: e.name })),
            ]}
            onChange={(v) => save({ defaultEditor: v === 'auto' ? null : v })}
          />
        </Row>
        <Row label="알림" hint="창이 뒤에 있을 때 턴 완료, 권한 요청, 계정 전환을 알립니다">
          <Switch size="md" checked={settings.notifications} aria-label="알림" onChange={(notifications) => save({ notifications })} />
        </Row>
        <Row
          label="New Task Start 템플릿"
          hint="새 채팅 화면의 'New Task Start' 버튼(⌘⇧N)이 입력창에 붙여넣는 문구입니다. {project}는 폴더 이름, {date}는 오늘 날짜로 바뀝니다"
          stack
        >
          <textarea
            className="hc-settings__textarea"
            aria-label="New Task Start 템플릿"
            maxLength={NEW_TASK_TEMPLATE_MAX_CHARS}
            value={templateDraft}
            onChange={(e) => setTemplateDraft(e.target.value)}
            onBlur={commitTemplate}
          />
          <div className="hc-settings__textarea-footer">
            <span className="hc-settings__char-count">
              {templateDraft.length} / {NEW_TASK_TEMPLATE_MAX_CHARS}
            </span>
            <Button variant="secondary" size="sm" onClick={resetTemplate}>
              기본값으로 되돌리기
            </Button>
          </div>
        </Row>
      </Section>

      <Section title="계정" description={`계정 ${accounts.length}개 · 활성 ${accounts.filter((a) => a.enabled).length}개`}>
        <Row
          label="한도 도달 시 자동 전환"
          hint={
            settings.autoSwitchAccounts
              ? '한도에 도달하면 다음 계정으로 이어서 실행합니다'
              : '같은 계정의 한도가 초기화될 때까지 기다린 뒤 이어서 실행합니다'
          }
        >
          <Switch
            size="md"
            checked={settings.autoSwitchAccounts}
            aria-label="한도 도달 시 자동 전환"
            onChange={(autoSwitchAccounts) => save({ autoSwitchAccounts })}
          />
        </Row>
        <Row label="사용량 조회 간격" hint="계정마다 이 간격으로 사용량을 새로 받아옵니다">
          <span className="hc-settings__range">
            <input
              type="range"
              min={USAGE_POLL_MIN_SEC}
              max={USAGE_POLL_MAX_SEC}
              step={30}
              aria-label="사용량 조회 간격 (초)"
              value={pollDraft}
              style={{ ['--hc-range' as string]: `${((pollDraft - USAGE_POLL_MIN_SEC) / (USAGE_POLL_MAX_SEC - USAGE_POLL_MIN_SEC)) * 100}%` }}
              onChange={(e) => setPollDraft(Number(e.target.value))}
              onPointerUp={() => pollDraft !== settings.usagePollIntervalSec && save({ usagePollIntervalSec: pollDraft })}
              onKeyUp={() => pollDraft !== settings.usagePollIntervalSec && save({ usagePollIntervalSec: pollDraft })}
            />
            <output className="hc-settings__range-value" aria-live="polite">
              {formatInterval(pollDraft)}
            </output>
          </span>
        </Row>
      </Section>

      <Section
        title="공유 설정"
        description={`${shared ? tildePath(shared.sourceDir, homeDir) : '~/.claude'}의 항목을 계정마다 링크해 같은 설정·스킬·훅을 씁니다`}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={relinking || accounts.length === 0}
            onClick={() => {
              setRelinking(true);
              void relinkShared()
                .then(setShared)
                .catch((err: unknown) => setError(`다시 연결하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`))
                .finally(() => setRelinking(false));
            }}
          >
            <GlyphRefresh width={13} height={13} />
            다시 연결
          </Button>
        }
      >
        <ul className="hc-settings__shared" aria-label="공유 항목">
          {(shared?.entries ?? []).map((entry) => {
            const states = Object.values(entry.byAccount);
            const linked = states.filter((st) => st === 'linked').length;
            const problem = states.find((st) => st === 'broken' || st === 'conflict');
            const tone = !entry.inSource ? 'muted' : problem ? 'warn' : linked === states.length && states.length > 0 ? 'ok' : 'muted';
            const text = !entry.inSource
              ? '원본 없음'
              : states.length === 0
                ? '계정 없음'
                : problem
                  ? `${STATE_LABEL[problem]} · ${linked}/${states.length}`
                  : `${STATE_LABEL.linked} ${linked}/${states.length}`;
            return (
              <li key={entry.name} className="hc-settings__shared-row">
                <code className="hc-settings__shared-name">{entry.name}</code>
                <span className={`hc-settings__chip hc-settings__chip--${tone}`}>{text}</span>
              </li>
            );
          })}
          {shared === null ? <li className="hc-settings__shared-row hc-settings__muted">불러오는 중…</li> : null}
        </ul>
      </Section>

      <Section title="데이터">
        <Row label="데이터 폴더" hint={dataDir ? tildePath(dataDir, homeDir) : ' '} hintMono>
          <Button variant="secondary" size="sm" onClick={() => void onOpenDataFolder().catch((err: unknown) => setError(String(err)))}>
            <GlyphFolderOpen width={13} height={13} />
            열기
          </Button>
        </Row>
        <Row label="보관된 스레드" hint={archivedCount > 0 ? `${archivedCount}개 · 대화 기록과 worktree가 함께 삭제됩니다` : '보관된 스레드가 없습니다'}>
          <Button variant="destructive" size="sm" disabled={archivedCount === 0} onClick={() => setConfirmDelete(true)}>
            모두 삭제…
          </Button>
        </Row>
      </Section>

      <Modal
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        role="alertdialog"
        title="보관된 스레드를 모두 삭제할까요?"
        dismissible={!deleting}
        width={420}
        actions={
          <>
            <Button variant="secondary" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              취소
            </Button>
            <Button
              variant="primary"
              className="hc-btn--danger-fill"
              disabled={deleting}
              onClick={() => {
                setDeleting(true);
                void onDeleteArchived()
                  .then(() => setConfirmDelete(false))
                  .catch((err: unknown) => setError(`삭제하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`))
                  .finally(() => setDeleting(false));
              }}
            >
              모두 삭제
            </Button>
          </>
        }
      >
        <p className="hc-settings__confirm">
          보관된 스레드 {archivedCount}개의 대화 기록과 worktree가 삭제됩니다. 커밋하지 않은 변경 사항도 함께 사라지며 되돌릴 수 없습니다.
        </p>
      </Modal>
    </div>
  );
}

function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="hc-settings__section" aria-label={title}>
      <div className="hc-settings__section-head">
        <div>
          <h2 className="hc-settings__section-title">{title}</h2>
          {description ? <p className="hc-settings__section-desc">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="hc-settings__card">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  hintMono = false,
  stack = false,
  children,
}: {
  label: string;
  hint?: string;
  hintMono?: boolean;
  /** Full-width control stacked below the label (a textarea) instead of the usual side-by-side layout. */
  stack?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`hc-settings__row${stack ? ' hc-settings__row--stack' : ''}`}>
      <div className="hc-settings__row-text">
        <div className="hc-settings__row-label">{label}</div>
        {hint ? <div className={`hc-settings__row-hint${hintMono ? ' hc-settings__row-hint--mono' : ''}`}>{hint}</div> : null}
      </div>
      <div className="hc-settings__row-control">{children}</div>
    </div>
  );
}

/** Pop-up button (macOS NSPopUpButton): current value + chevron, radio menu below. */
function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = useMemo(() => options.find((o) => o.value === value), [options, value]);
  const sections: MenuSection[] = [
    {
      key: 'options',
      kind: 'radio',
      items: options.map((o) => ({ key: o.value, label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) })),
    },
  ];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="hc-select"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hc-select__value">{current?.label ?? value}</span>
        <GlyphChevronDown />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label={label} placement="bottom-end" width={260} />
    </>
  );
}
