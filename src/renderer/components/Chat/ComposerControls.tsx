// Chips on the composer's control row: agent, folder (draft only), permission mode, model + effort, and the ACP
// agents' own chips (Codex model / effort from config options, Hermes modes and its read-only model label).
import { memo, useRef, useState } from 'react';
import type { Account, AgentKind, EffortLevel, LocalAuthInfo, ModelOption, Project, UiPermissionMode } from '../../../shared/types';
import { AGENTS } from '../../../shared/agents';
import { AgentIcon } from '../Agent/AgentIcon';
import { EFFORT_LEVELS, UI_PERMISSION_MODES } from '../../../shared/constants';
import { concreteModelLabel, isModelSelected, modelMenuLabel } from '../../../core/modelDisplay';
import { tildePath } from '../../../core/format';
import { Menu, type MenuSection } from '../common';
import { GlyphRefresh } from '../common/glyphs';
import { EFFORT_LABEL, type ChipChoice } from './acpChips';
import { agentMenuState } from './agentMenuState';
import { BoltIcon, ChevronDownSmallIcon, FolderIcon, FolderOpenIcon, PersonIcon, ShieldAlertIcon, ShieldIcon } from './icons';

export { EFFORT_LABEL };

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const PERMISSION_MODE_LABEL: Record<UiPermissionMode, string> = {
  default: '기본',
  plan: '계획',
  acceptEdits: '편집 자동 승인',
  bypassPermissions: '전체 액세스',
};

const PERMISSION_MODE_DESC: Record<UiPermissionMode, string> = {
  default: '파일 변경과 명령 실행 전에 묻습니다',
  plan: '계획만 세우고 편집·명령은 하지 않습니다',
  acceptEdits: '파일 편집은 묻지 않고 적용합니다',
  bypassPermissions: '모든 도구를 묻지 않고 실행합니다 (확인 필요)',
};

const EFFORT_DESC: Record<EffortLevel, string> = {
  low: '가장 빠른 응답',
  medium: '적당한 추론',
  high: '깊은 추론',
  xhigh: 'High보다 깊게',
  max: '최대 추론',
};

/** Levels to offer for `model`: its reported list, the full list when unknown, none when unsupported. */
export function effortLevelsFor(models: readonly ModelOption[], model: string): readonly EffortLevel[] {
  const option = models.find((m) => isModelSelected(model, m, models));
  if (option?.effortLevels) return option.effortLevels;
  return EFFORT_LEVELS;
}

// ---------------------------------------------------------------------------
// Folder chip (draft)
// ---------------------------------------------------------------------------

export interface FolderChipProps {
  projects: Project[];
  /** null: "프로젝트 없이 작업" (the chat runs in an app-managed scratch folder). */
  projectId: string | null;
  onSelect: (projectId: string | null) => void;
  /** "다른 폴더 선택…": native folder dialog + trust question (project:add). */
  onPickOther: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Home directory: menu paths are shown as `~/…`. */
  homeDir?: string | null;
}

export const NO_PROJECT_LABEL = '프로젝트 없음';

/** One width for every composer menu (+, folder, permission, account, model). */
export const COMPOSER_MENU_WIDTH = 288;
/** The agent menu carries "<vendor> · <model>" lines; give them room so model names do not truncate. */
const AGENT_MENU_WIDTH = 360;

export const FolderChip = memo(function FolderChip({
  projects,
  projectId,
  onSelect,
  onPickOther,
  open,
  onOpenChange,
  homeDir = null,
}: FolderChipProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const current = projects.find((p) => p.id === projectId) ?? null;
  const recent = [...projects].sort((a, b) => b.createdAt - a.createdAt);
  const sections: MenuSection[] = [
    ...(recent.length > 0
      ? [
          {
            key: 'recent',
            title: '최근 프로젝트',
            kind: 'radio' as const,
            items: recent.map((p) => ({
              key: p.id,
              label: p.name,
              description: tildePath(p.path, homeDir),
              icon: <FolderIcon />,
              checked: p.id === projectId,
              onSelect: () => onSelect(p.id),
            })),
          },
        ]
      : []),
    {
      key: 'scratch',
      kind: 'radio',
      items: [
        {
          key: 'scratch',
          label: '프로젝트 없이 작업',
          description: '앱이 만든 빈 폴더에서 시작합니다 (git 기능 없음)',
          icon: <ChatBubbleGlyph />,
          checked: current === null,
          onSelect: () => onSelect(null),
        },
      ],
    },
    {
      key: 'other',
      kind: 'action',
      items: [{ key: 'pick', label: '다른 폴더 선택…', icon: <FolderOpenIcon />, onSelect: onPickOther }],
    },
  ];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`hc-chip hc-chip--folder${current ? '' : ' hc-chip--scratch'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={current ? `폴더: ${current.name}` : `폴더: ${NO_PROJECT_LABEL}`}
        title={current ? tildePath(current.path, homeDir) : '프로젝트 없이 시작합니다. 폴더를 고르려면 누르세요'}
        onClick={() => onOpenChange(!open)}
      >
        {current ? <FolderIcon /> : <ChatBubbleGlyph />}
        <span className="hc-chip__label">{current?.name ?? NO_PROJECT_LABEL}</span>
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={ref}
        sections={sections}
        label="폴더"
        placement="top-start"
        width={COMPOSER_MENU_WIDTH}
      />
    </>
  );
});

/** "프로젝트 없이 작업": a speech bubble (same 16px / 1.5 stroke grid as FolderIcon). */
function ChatBubbleGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.25 3.5h9.5a1.25 1.25 0 0 1 1.25 1.25v5.5a1.25 1.25 0 0 1-1.25 1.25H8.5l-2.75 2.25V11.5h-2.5A1.25 1.25 0 0 1 2 10.25v-5.5A1.25 1.25 0 0 1 3.25 3.5Z" />
    </svg>
  );
}

/** Started thread: folder name only (the worktree lives under it; it cannot change). */
export function FolderTag({ name, path, homeDir = null }: { name: string; path: string; homeDir?: string | null }) {
  return (
    <span className="hc-chip hc-chip--static" title={tildePath(path, homeDir)} aria-label={`폴더: ${name}`}>
      <FolderIcon />
      <span className="hc-chip__label">{name}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Permission chip
// ---------------------------------------------------------------------------

/** Codex maps the app modes onto approval_policy / sandbox_mode (plan 2.15); acceptEdits has no own value there. */
const CODEX_MODE_NOTE: Partial<Record<UiPermissionMode, string>> = {
  acceptEdits: 'Codex에서는 기본과 같음',
};

export const PermissionChip = memo(function PermissionChip({
  value,
  onChange,
  agent = 'claude-code',
}: {
  value: UiPermissionMode;
  onChange: (mode: UiPermissionMode) => void;
  agent?: AgentKind;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const bypass = value === 'bypassPermissions';
  const sections: MenuSection[] = [
    {
      key: 'modes',
      title: '권한',
      kind: 'radio',
      items: UI_PERMISSION_MODES.map((mode) => ({
        key: mode,
        label: PERMISSION_MODE_LABEL[mode],
        description: (agent === 'codex' ? CODEX_MODE_NOTE[mode] : undefined) ?? PERMISSION_MODE_DESC[mode],
        icon: mode === 'bypassPermissions' ? <ShieldAlertIcon /> : <ShieldIcon />,
        tone: mode === 'bypassPermissions' ? ('warn' as const) : ('default' as const),
        checked: mode === value,
        onSelect: () => onChange(mode),
      })),
    },
  ];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`hc-chip hc-chip--perm${bypass ? ' hc-chip--warn' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`권한: ${PERMISSION_MODE_LABEL[value]}`}
        title={PERMISSION_MODE_DESC[value]}
        onClick={() => setOpen((v) => !v)}
      >
        {bypass ? <ShieldAlertIcon /> : <ShieldIcon />}
        <span className="hc-chip__label">{PERMISSION_MODE_LABEL[value]}</span>
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label="권한" placement="top-start" width={COMPOSER_MENU_WIDTH} />
    </>
  );
});

// ---------------------------------------------------------------------------
// Account pin (menu section; shown in the top-right "더보기" menu)
// ---------------------------------------------------------------------------

/** "계정 고정" radio section: 자동 (priority order) or one enabled account. */
export function accountPinSection(
  accounts: Account[],
  pinnedAccountId: string | null,
  activeAccountId: string | null,
  onChange: (accountId: string | null) => void,
): MenuSection {
  const ordered = [...accounts].sort((a, b) => a.priority - b.priority);
  return {
    key: 'accounts',
    title: '계정 고정',
    kind: 'radio',
    items: [
      {
        key: 'auto',
        label: '자동',
        description: '우선순위가 가장 높은 사용 가능한 계정',
        icon: <PersonIcon />,
        checked: pinnedAccountId === null,
        onSelect: () => onChange(null),
      },
      ...ordered.map((a) => ({
        key: a.id,
        label: a.alias,
        description: a.email ?? undefined,
        icon: <span className="hc-chip__dot" style={{ background: a.color }} />,
        meta: a.id === activeAccountId ? '사용 중' : !a.enabled ? '비활성' : undefined,
        disabled: !a.enabled,
        checked: a.id === pinnedAccountId,
        onSelect: () => onChange(a.id),
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Model + effort picker
// ---------------------------------------------------------------------------

export const ModelPicker = memo(function ModelPicker({
  models,
  model,
  effort,
  onModelChange,
  onEffortChange,
  defaultLabel,
  resolvedModel = null,
}: {
  models: ModelOption[];
  model: string;
  effort: EffortLevel | null;
  /** What `default` runs as (e.g. "Fable 5"). */
  defaultLabel?: string;
  /** Id the live session reported (wins over the alias). */
  resolvedModel?: string | null;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: EffortLevel | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const label = concreteModelLabel(model, models, { resolvedModel, defaultLabel });
  const levels = effortLevelsFor(models, model);
  const sections: MenuSection[] = [
    {
      key: 'models',
      title: '모델',
      kind: 'radio',
      items: models.map((m) => ({
        key: m.value,
        label: modelMenuLabel(m.value, models, defaultLabel),
        description: m.description,
        checked: isModelSelected(model, m, models),
        keepOpen: true,
        onSelect: () => onModelChange(m.value),
      })),
    },
    ...(levels.length > 0
      ? [
          {
            key: 'effort',
            title: 'Effort',
            kind: 'radio' as const,
            items: [
              {
                key: 'default',
                label: '기본값',
                meta: '모델 기본',
                checked: effort === null,
                onSelect: () => onEffortChange(null),
              },
              ...levels.map((level) => ({
                key: level,
                label: EFFORT_LABEL[level],
                meta: EFFORT_DESC[level],
                checked: effort === level,
                onSelect: () => onEffortChange(level),
              })),
            ],
          },
        ]
      : []),
  ];
  const showEffort = effort !== null && levels.includes(effort);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="hc-chip hc-chip--model"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`모델: ${label}${showEffort ? ` · ${EFFORT_LABEL[effort]}` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <BoltIcon />
        <span className="hc-chip__label">{label}</span>
        {showEffort ? <span className="hc-chip__sub">{EFFORT_LABEL[effort]}</span> : null}
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label="모델" placement="top-end" width={COMPOSER_MENU_WIDTH} />
    </>
  );
});

// ---------------------------------------------------------------------------
// Agent chip (first chip): picker in a draft, a static tag once the thread runs
// ---------------------------------------------------------------------------

export const AgentChip = memo(function AgentChip({
  value,
  onChange,
  localAuth = [],
  onRecheck,
}: {
  value: AgentKind;
  /** Absent: the thread already runs with this agent (static chip). */
  onChange?: (agent: AgentKind) => void;
  /** Local login detection: agents that are not installed / not logged in are disabled with the reason. */
  localAuth?: readonly LocalAuthInfo[];
  /** "상태 다시 확인" (agents:recheck); shown while some agent is unavailable. */
  onRecheck?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = AGENTS[value];
  if (!onChange) {
    return (
      <span className="hc-chip hc-chip--static hc-chip--agent" aria-label={`에이전트: ${current.name}`}>
        <AgentIcon kind={value} size={15} />
        <span className="hc-chip__label">{current.name}</span>
      </span>
    );
  }
  const rows = agentMenuState(localAuth);
  const anyUnavailable = rows.some((r) => r.disabled);
  const sections: MenuSection[] = [
    {
      key: 'agents',
      title: '에이전트',
      kind: 'radio',
      items: rows.map((row) => ({
        key: row.agent,
        label: row.name,
        description: row.description,
        icon: <AgentIcon kind={row.agent} size={16} />,
        tone: row.disabled && row.reason !== 'checking' ? ('warn' as const) : ('default' as const),
        disabled: row.disabled,
        checked: row.agent === value,
        onSelect: () => onChange(row.agent),
      })),
    },
    ...(anyUnavailable && onRecheck
      ? [
          {
            key: 'recheck',
            kind: 'action' as const,
            items: [{ key: 'recheck', label: '설치·로그인 상태 다시 확인', icon: <GlyphRefresh width={16} height={16} />, keepOpen: true, onSelect: onRecheck }],
          },
        ]
      : []),
  ];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="hc-chip hc-chip--agent"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`에이전트: ${current.name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <AgentIcon kind={value} size={15} />
        <span className="hc-chip__label">{current.name}</span>
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label="에이전트" placement="top-start" width={AGENT_MENU_WIDTH} />
    </>
  );
});

// ---------------------------------------------------------------------------
// ACP chips: Codex model + effort (config options), Hermes modes and read-only model
// ---------------------------------------------------------------------------

/**
 * Model + effort picker over plain choices (Codex). Same look as ModelPicker. `readOnly` (no session reported its
 * options yet) keeps the values visible as a static tag.
 */
export const AcpModelChip = memo(function AcpModelChip({
  modelLabel,
  effortLabel,
  model,
  effort,
  models,
  efforts,
  onModelChange,
  onEffortChange,
  readOnlyTitle,
}: {
  modelLabel: string;
  effortLabel: string | null;
  model: string;
  effort: string | null;
  models: readonly ChipChoice[];
  efforts: readonly ChipChoice[];
  onModelChange?: (value: string) => void;
  onEffortChange?: (value: string) => void;
  /** Static chip with this tooltip (nothing to pick from yet). */
  readOnlyTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const aria = `모델: ${modelLabel}${effortLabel ? ` · ${effortLabel}` : ''}`;
  const canPick = (onModelChange && models.length > 0) || (onEffortChange && efforts.length > 0);
  if (readOnlyTitle || !canPick) {
    return (
      <span className="hc-chip hc-chip--model hc-chip--readonly" aria-label={aria} title={readOnlyTitle}>
        <BoltIcon />
        <span className="hc-chip__label">{modelLabel}</span>
        {effortLabel ? <span className="hc-chip__sub">{effortLabel}</span> : null}
      </span>
    );
  }
  const sections: MenuSection[] = [
    ...(onModelChange && models.length > 0
      ? [
          {
            key: 'models',
            title: '모델',
            kind: 'radio' as const,
            items: models.map((m) => ({
              key: m.value,
              label: m.label,
              description: m.description,
              checked: m.value === model,
              keepOpen: true,
              onSelect: () => onModelChange(m.value),
            })),
          },
        ]
      : []),
    ...(onEffortChange && efforts.length > 0
      ? [
          {
            key: 'effort',
            title: 'Effort',
            kind: 'radio' as const,
            items: efforts.map((e) => ({
              key: e.value,
              label: e.label,
              meta: e.description,
              checked: e.value === effort,
              onSelect: () => onEffortChange(e.value),
            })),
          },
        ]
      : []),
  ];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="hc-chip hc-chip--model"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={aria}
        onClick={() => setOpen((v) => !v)}
      >
        <BoltIcon />
        <span className="hc-chip__label">{modelLabel}</span>
        {effortLabel ? <span className="hc-chip__sub">{effortLabel}</span> : null}
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label="모델" placement="top-end" width={COMPOSER_MENU_WIDTH} />
    </>
  );
});

/** Hermes: the model is the agent's own system default; the app only shows what it reported. */
export function SystemModelTag({ label, title }: { label: string; title?: string }) {
  return (
    <span
      className="hc-chip hc-chip--model hc-chip--readonly"
      aria-label={`모델: ${label}`}
      title={title ? `${title}\nHermes의 시스템 기본 설정을 그대로 씁니다` : 'Hermes의 시스템 기본 설정을 그대로 씁니다. 모델은 Hermes에서 바꾸세요'}
      data-testid="system-model-tag"
    >
      <BoltIcon />
      <span className="hc-chip__label">{label}</span>
    </span>
  );
}

/** ACP session modes (Hermes): the agent's own approval policy, one radio list. */
export const AgentModeChip = memo(function AgentModeChip({
  label,
  currentModeId,
  modes,
  onChange,
}: {
  label: string;
  currentModeId: string | null;
  modes: readonly ChipChoice[];
  onChange: (modeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const sections: MenuSection[] = [
    {
      key: 'modes',
      title: '에이전트 모드',
      kind: 'radio',
      items: modes.map((m) => ({
        key: m.value,
        label: m.label,
        description: m.description,
        icon: <ShieldIcon />,
        checked: m.value === currentModeId,
        onSelect: () => onChange(m.value),
      })),
    },
  ];
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="hc-chip hc-chip--perm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`모드: ${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <ShieldIcon />
        <span className="hc-chip__label">{label}</span>
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label="에이전트 모드" placement="top-start" width={COMPOSER_MENU_WIDTH} />
    </>
  );
});
