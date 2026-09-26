// Chips on the composer's control row: agent, folder (draft only), permission mode, model + effort.
import { memo, useRef, useState } from 'react';
import type { Account, AgentKind, EffortLevel, ModelOption, Project, UiPermissionMode } from '../../../shared/types';
import { AGENT_KINDS, AGENTS } from '../../../shared/agents';
import { AgentIcon } from '../Agent/AgentIcon';
import { EFFORT_LEVELS, UI_PERMISSION_MODES } from '../../../shared/constants';
import { concreteModelLabel, modelMenuLabel } from '../../../core/modelDisplay';
import { tildePath } from '../../../core/format';
import { Menu, type MenuSection } from '../common';
import { BoltIcon, ChevronDownSmallIcon, FolderIcon, FolderOpenIcon, PersonIcon, ShieldAlertIcon, ShieldIcon } from './icons';

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

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
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
  const option = models.find((m) => m.value === model);
  if (option?.effortLevels) return option.effortLevels;
  return EFFORT_LEVELS;
}

// ---------------------------------------------------------------------------
// Folder chip (draft)
// ---------------------------------------------------------------------------

export interface FolderChipProps {
  projects: Project[];
  projectId: string | null;
  onSelect: (projectId: string) => void;
  /** "다른 폴더 선택…": native folder dialog + trust question (project:add). */
  onPickOther: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pulses the chip after a send without a folder. */
  attention?: boolean;
  /** Home directory: menu paths are shown as `~/…`. */
  homeDir?: string | null;
}

/** One width for every composer menu (+, folder, permission, account, model). */
export const COMPOSER_MENU_WIDTH = 288;

export const FolderChip = memo(function FolderChip({
  projects,
  projectId,
  onSelect,
  onPickOther,
  open,
  onOpenChange,
  attention = false,
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
        className={`hc-chip hc-chip--folder${current ? '' : ' hc-chip--empty'}${attention ? ' hc-chip--attention' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={current ? `폴더: ${current.name}` : '폴더 선택'}
        title={current ? tildePath(current.path, homeDir) : '이 채팅을 시작할 폴더를 선택하세요'}
        onClick={() => onOpenChange(!open)}
      >
        <FolderIcon />
        <span className="hc-chip__label">{current?.name ?? '폴더 선택'}</span>
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

export const PermissionChip = memo(function PermissionChip({
  value,
  onChange,
}: {
  value: UiPermissionMode;
  onChange: (mode: UiPermissionMode) => void;
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
        description: PERMISSION_MODE_DESC[mode],
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
        checked: m.value === model,
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
}: {
  value: AgentKind;
  /** Absent: the thread already runs with this agent (static chip). */
  onChange?: (agent: AgentKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = AGENTS[value];
  if (!onChange) {
    return (
      <span className="hc-chip hc-chip--static hc-chip--agent" aria-label={`에이전트: ${current.name}`} title={current.description}>
        <AgentIcon kind={value} size={15} />
        <span className="hc-chip__label">{current.name}</span>
      </span>
    );
  }
  const sections: MenuSection[] = [
    {
      key: 'agents',
      title: '에이전트',
      kind: 'radio',
      items: AGENT_KINDS.map((kind) => ({
        key: kind,
        label: AGENTS[kind].name,
        description: AGENTS[kind].description,
        icon: <AgentIcon kind={kind} size={16} />,
        checked: kind === value,
        onSelect: () => onChange(kind),
      })),
    },
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
        title={current.description}
        onClick={() => setOpen((v) => !v)}
      >
        <AgentIcon kind={value} size={15} />
        <span className="hc-chip__label">{current.name}</span>
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label="에이전트" placement="top-start" width={COMPOSER_MENU_WIDTH} />
    </>
  );
});
