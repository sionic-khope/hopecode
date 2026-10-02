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
import { t, type MessageKey } from '../../../shared/i18n';
import { useLanguage } from '../../i18n';

export { EFFORT_LABEL };

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const PERMISSION_MODE_KEY: Record<UiPermissionMode, MessageKey> = {
  default: 'mode.default',
  plan: 'mode.plan',
  acceptEdits: 'mode.acceptEdits',
  bypassPermissions: 'mode.bypass',
};

/** Permission mode name in the current language (`기본`, `계획`, …). */
export function permissionModeLabel(mode: UiPermissionMode): string {
  return t(PERMISSION_MODE_KEY[mode]);
}

const PERMISSION_MODE_DESC: Record<UiPermissionMode, MessageKey> = {
  default: 'mode.default.desc',
  plan: 'mode.plan.desc',
  acceptEdits: 'mode.acceptEdits.desc',
  bypassPermissions: 'mode.bypass.desc',
};

const EFFORT_DESC: Record<EffortLevel, MessageKey> = {
  low: 'effort.low.desc',
  medium: 'effort.medium.desc',
  high: 'effort.high.desc',
  xhigh: 'effort.xhigh.desc',
  max: 'effort.max.desc',
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

/** Folder chip label of a chat without a project. */
export function noProjectLabel(): string {
  return t('folder.noProject');
}

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
  useLanguage();
  const ref = useRef<HTMLButtonElement>(null);
  const current = projects.find((p) => p.id === projectId) ?? null;
  const recent = [...projects].sort((a, b) => b.createdAt - a.createdAt);
  const sections: MenuSection[] = [
    ...(recent.length > 0
      ? [
          {
            key: 'recent',
            title: t('folder.recent'),
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
          label: t('folder.noProjectWork'),
          description: t('folder.noProjectWork.desc'),
          icon: <ChatBubbleGlyph />,
          checked: current === null,
          onSelect: () => onSelect(null),
        },
      ],
    },
    {
      key: 'other',
      kind: 'action',
      items: [{ key: 'pick', label: t('folder.pickOther'), icon: <FolderOpenIcon />, onSelect: onPickOther }],
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
        aria-label={t('folder.aria', { name: current ? current.name : noProjectLabel() })}
        title={current ? tildePath(current.path, homeDir) : t('folder.noProjectTitle')}
        onClick={() => onOpenChange(!open)}
      >
        {current ? <FolderIcon /> : <ChatBubbleGlyph />}
        <span className="hc-chip__label">{current?.name ?? noProjectLabel()}</span>
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={ref}
        sections={sections}
        label={t('folder.label')}
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
  useLanguage();
  return (
    <span className="hc-chip hc-chip--static" title={tildePath(path, homeDir)} aria-label={t('folder.aria', { name })}>
      <FolderIcon />
      <span className="hc-chip__label">{name}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Permission chip
// ---------------------------------------------------------------------------

/** Codex maps the app modes onto approval_policy / sandbox_mode (plan 2.15); acceptEdits has no own value there. */
const CODEX_MODE_NOTE: Partial<Record<UiPermissionMode, MessageKey>> = {
  acceptEdits: 'mode.codexAcceptEditsNote',
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
  useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const bypass = value === 'bypassPermissions';
  const sections: MenuSection[] = [
    {
      key: 'modes',
      title: t('mode.title'),
      kind: 'radio',
      items: UI_PERMISSION_MODES.map((mode) => ({
        key: mode,
        label: permissionModeLabel(mode),
        description: t((agent === 'codex' ? CODEX_MODE_NOTE[mode] : undefined) ?? PERMISSION_MODE_DESC[mode]),
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
        aria-label={t('mode.aria', { mode: permissionModeLabel(value) })}
        title={t(PERMISSION_MODE_DESC[value])}
        onClick={() => setOpen((v) => !v)}
      >
        {bypass ? <ShieldAlertIcon /> : <ShieldIcon />}
        <span className="hc-chip__label">{permissionModeLabel(value)}</span>
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label={t('mode.title')} placement="top-start" width={COMPOSER_MENU_WIDTH} />
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
    title: t('accountPin.title'),
    kind: 'radio',
    items: [
      {
        key: 'auto',
        label: t('common.auto'),
        description: t('accountPin.auto.desc'),
        icon: <PersonIcon />,
        checked: pinnedAccountId === null,
        onSelect: () => onChange(null),
      },
      ...ordered.map((a) => ({
        key: a.id,
        label: a.alias,
        description: a.email ?? undefined,
        icon: <span className="hc-chip__dot" style={{ background: a.color }} />,
        meta: a.id === activeAccountId ? t('accountPin.inUse') : !a.enabled ? t('accountPin.disabled') : undefined,
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
  useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const label = concreteModelLabel(model, models, { resolvedModel, defaultLabel });
  const levels = effortLevelsFor(models, model);
  const sections: MenuSection[] = [
    {
      key: 'models',
      title: t('model.title'),
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
                label: t('model.defaultValue'),
                meta: t('model.modelDefault'),
                checked: effort === null,
                onSelect: () => onEffortChange(null),
              },
              ...levels.map((level) => ({
                key: level,
                label: EFFORT_LABEL[level],
                meta: t(EFFORT_DESC[level]),
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
        aria-label={t('model.aria', { model: `${label}${showEffort ? ` · ${EFFORT_LABEL[effort]}` : ''}` })}
        onClick={() => setOpen((v) => !v)}
      >
        <BoltIcon />
        <span className="hc-chip__label">{label}</span>
        {showEffort ? <span className="hc-chip__sub">{EFFORT_LABEL[effort]}</span> : null}
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label={t('model.title')} placement="top-end" width={COMPOSER_MENU_WIDTH} />
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
  agents,
}: {
  value: AgentKind;
  /** Absent: the thread already runs with this agent (static chip). */
  onChange?: (agent: AgentKind) => void;
  /** Local login detection: agents that are not installed / not logged in are disabled with the reason. */
  localAuth?: readonly LocalAuthInfo[];
  /** "상태 다시 확인" (agents:recheck); shown while some agent is unavailable. */
  onRecheck?: () => void;
  /** Agents the picker offers (default: all). */
  agents?: readonly AgentKind[];
}) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = AGENTS[value];
  if (!onChange) {
    return (
      <span className="hc-chip hc-chip--static hc-chip--agent" aria-label={t('agent.aria', { name: current.name })}>
        <AgentIcon kind={value} size={15} />
        <span className="hc-chip__label">{current.name}</span>
      </span>
    );
  }
  const rows = agentMenuState(localAuth).filter((r) => !agents || agents.includes(r.agent));
  const anyUnavailable = rows.some((r) => r.disabled);
  const sections: MenuSection[] = [
    {
      key: 'agents',
      title: t('agent.title'),
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
            items: [{ key: 'recheck', label: t('agent.recheck'), icon: <GlyphRefresh width={16} height={16} />, keepOpen: true, onSelect: onRecheck }],
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
        aria-label={t('agent.aria', { name: current.name })}
        onClick={() => setOpen((v) => !v)}
      >
        <AgentIcon kind={value} size={15} />
        <span className="hc-chip__label">{current.name}</span>
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label={t('agent.title')} placement="top-start" width={AGENT_MENU_WIDTH} />
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
  useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const aria = t('model.aria', { model: `${modelLabel}${effortLabel ? ` · ${effortLabel}` : ''}` });
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
            title: t('model.title'),
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
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label={t('model.title')} placement="top-end" width={COMPOSER_MENU_WIDTH} />
    </>
  );
});

/** Hermes: the model is the agent's own system default; the app only shows what it reported. */
export function SystemModelTag({ label, title }: { label: string; title?: string }) {
  useLanguage();
  return (
    <span
      className="hc-chip hc-chip--model hc-chip--readonly"
      aria-label={t('model.aria', { model: label })}
      title={title ? `${title}\n${t('hermes.systemDefault')}` : t('hermes.systemDefault.change')}
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
  useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const sections: MenuSection[] = [
    {
      key: 'modes',
      title: t('agentMode.title'),
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
        aria-label={t('agentMode.aria', { mode: label })}
        onClick={() => setOpen((v) => !v)}
      >
        <ShieldIcon />
        <span className="hc-chip__label">{label}</span>
        <ChevronDownSmallIcon className="hc-chip__chevron" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label={t('agentMode.title')} placement="top-start" width={COMPOSER_MENU_WIDTH} />
    </>
  );
});
