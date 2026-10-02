import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_NEW_TASK_TEMPLATE,
  EFFORT_LEVELS,
  IDLE_CLOSE_MAX_MINUTES,
  NEW_TASK_TEMPLATE_MAX_CHARS,
  PROFILE_NAME_MAX_CHARS,
  UI_PERMISSION_MODES,
  USAGE_POLL_MAX_SEC,
  USAGE_POLL_MIN_SEC,
} from '../../../shared/constants';
import type {
  Account,
  AppSettings,
  EditorId,
  EditorInfo,
  CodexEffortLevel,
  EffortLevel,
  ModelOption,
  SettingsPatch,
  SharedConfigStatus,
  SharedEntryState,
  UiPermissionMode,
} from '../../../shared/types';
import { isModelSelected, modelMenuLabel } from '../../../core/modelDisplay';
import { tildePath } from '../../../core/format';
import { AGENTS } from '../../../shared/agents';
import type { AgentKind } from '../../../shared/types';
import { hermesModelLabel } from '../../../core/hermesModelLabel';
import { useAppStore } from '../../store';
import { AgentIcon } from '../Agent/AgentIcon';
import { Button, Menu, Modal, Segmented, Switch, type MenuSection } from '../common';
import { GlyphChevronDown, GlyphFolderOpen, GlyphRefresh } from '../common/glyphs';
import { EFFORT_LABEL, permissionModeLabel } from '../Chat/ComposerControls';
import { codexEffortChoices, codexModelChoices, systemDefaultLabel } from '../Chat/acpChips';
import { LANGUAGES, LANGUAGE_NATIVE_NAMES, resolveLanguage, t, type LanguageSetting, type MessageKey } from '../../../shared/i18n';
import { useLanguage } from '../../i18n';
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

const STATE_KEY: Record<SharedEntryState, MessageKey> = {
  linked: 'settings.shared.linked',
  'not-linked': 'settings.shared.notLinked',
  broken: 'settings.shared.broken',
  conflict: 'settings.shared.conflict',
};

/** Seconds -> `1분 30초` / `1 min 30 sec` style. */
export function formatInterval(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return t('settings.interval.sec', { s });
  return s === 0 ? t('settings.interval.min', { m }) : t('settings.interval.minSec', { m, s });
}

/** 'system' first (named after what it resolves to), then each language in its own script. */
function languageOptions(systemLocale: string | null): { value: LanguageSetting; label: string }[] {
  const locales = systemLocale ? [systemLocale] : typeof navigator === 'undefined' ? [] : [...navigator.languages];
  const system = LANGUAGE_NATIVE_NAMES[resolveLanguage('system', locales)];
  return [
    { value: 'system', label: t('settings.language.system', { language: system }) },
    ...LANGUAGES.map((lang) => ({ value: lang as LanguageSetting, label: LANGUAGE_NATIVE_NAMES[lang] })),
  ];
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
  useLanguage();
  const systemLocale = useAppStore((s) => s.systemLocale);
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
  const [nameDraft, setNameDraft] = useState(settings.profileName);
  const [codexPathDraft, setCodexPathDraft] = useState(settings.codexPath);

  useEffect(() => setIdleDraft(String(settings.idleCloseMinutes)), [settings.idleCloseMinutes]);
  useEffect(() => setPollDraft(settings.usagePollIntervalSec), [settings.usagePollIntervalSec]);
  useEffect(() => setTemplateDraft(settings.newTaskTemplate), [settings.newTaskTemplate]);
  useEffect(() => setNameDraft(settings.profileName), [settings.profileName]);
  useEffect(() => setCodexPathDraft(settings.codexPath), [settings.codexPath]);

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
    void onUpdate(patch).catch((err: unknown) => setError(t('settings.err.save', { error: err instanceof Error ? err.message : String(err) })));
  };

  const commitIdle = () => {
    const n = Number(idleDraft);
    if (!Number.isInteger(n) || n < 0 || n > IDLE_CLOSE_MAX_MINUTES) {
      setIdleDraft(String(settings.idleCloseMinutes));
      return;
    }
    if (n !== settings.idleCloseMinutes) save({ idleCloseMinutes: n });
  };

  const commitName = () => {
    const next = nameDraft.trim();
    setNameDraft(next);
    if (next !== settings.profileName) save({ profileName: next });
  };

  // Main checks the file (`--version` -> codex-cli >= minimum) before storing; a refused path reverts the field.
  const commitCodexPath = () => {
    const next = codexPathDraft.trim();
    setCodexPathDraft(next);
    if (next === settings.codexPath) return;
    setError(null);
    void onUpdate({ codexPath: next }).catch((err: unknown) => {
      setCodexPathDraft(settings.codexPath);
      setError(t('settings.err.codexPath', { error: err instanceof Error ? err.message : String(err) }));
    });
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
  const threads = useAppStore((s) => s.threads);
  const hermesInfo = useAppStore((s) => s.localAuth.find((i) => i.agent === 'hermes'));
  const codexInfo = useAppStore((s) => s.localAuth.find((i) => i.agent === 'codex'));
  const codexModels = useMemo(() => codexModelChoices(threads, settings.codexDefaultModel), [threads, settings.codexDefaultModel]);
  const effortLabel = (e: EffortLevel | CodexEffortLevel) => (e === 'xhigh' ? 'XHigh' : EFFORT_LABEL[e]);
  const codexEfforts = useMemo(() => codexEffortChoices(threads), [threads]);

  return (
    <div className="hc-settings" data-testid="settings">
      <header className="hc-settings__header">
        <Button variant="plain" size="sm" icon aria-label={t('common.back')} onClick={onBack}>
          <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10 3.5 5 8l5 4.5" />
          </svg>
        </Button>
        <div>
          <h1 className="hc-settings__title">{t('settings.title')}</h1>
          <p className="hc-settings__lede">{t('settings.lede')}</p>
        </div>
      </header>
      {error ? (
        <div className="hc-settings__error" role="alert">
          {error}
        </div>
      ) : null}

      <Section title={t('settings.general')} description={t('settings.general.desc')}>
        <Row label={t('settings.language')} hint={t('settings.language.hint')}>
          <SelectMenu<LanguageSetting>
            label={t('settings.language')}
            testId="settings-language"
            value={settings.language}
            options={languageOptions(systemLocale)}
            onChange={(language) => save({ language })}
          />
        </Row>
        <Row label={t('settings.profileName')} hint={t('settings.profileName.hint')}>
          <input
            id="hc-profile-name"
            type="text"
            className="hc-settings__text"
            aria-label={t('settings.profileName')}
            placeholder={t('settings.profileName.placeholder')}
            maxLength={PROFILE_NAME_MAX_CHARS}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </Row>
        <Row label={t('settings.defaultMode')} hint={t('settings.defaultMode.hint')}>
          <Segmented
            aria-label={t('settings.defaultMode')}
            size="sm"
            value={settings.defaultPermissionMode === 'bypassPermissions' ? 'default' : settings.defaultPermissionMode}
            options={DEFAULT_MODES.map((m) => ({ value: m, label: permissionModeLabel(m) }))}
            onChange={(defaultPermissionMode) => save({ defaultPermissionMode })}
          />
        </Row>
        <Row
          label={t('settings.worktree')}
          hint={
            settings.useWorktree
              ? t('settings.worktree.on')
              : t('settings.worktree.off')
          }
        >
          <Switch size="md" checked={settings.useWorktree} aria-label={t('settings.worktree')} onChange={(useWorktree) => save({ useWorktree })} />
        </Row>
        <Row label={t('settings.idle')} hint={t('settings.idle.hint')}>
          <span className="hc-settings__number">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={IDLE_CLOSE_MAX_MINUTES}
              step={1}
              aria-label={t('settings.idle.aria')}
              value={idleDraft}
              onChange={(e) => setIdleDraft(e.target.value)}
              onBlur={commitIdle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
            <span>{t('settings.idle.unit')}</span>
          </span>
        </Row>
        <Row label={t('settings.editor')} hint={t('settings.editor.hint')}>
          <SelectMenu<EditorId | 'auto'>
            label={t('settings.editor')}
            value={settings.defaultEditor ?? 'auto'}
            options={[
              { value: 'auto', label: editors[0] ? t('settings.editor.autoWith', { name: editors[0].name }) : t('common.auto') },
              ...editors.map((e) => ({ value: e.id, label: e.name })),
            ]}
            onChange={(v) => save({ defaultEditor: v === 'auto' ? null : v })}
          />
        </Row>
        <Row label={t('settings.notifications')} hint={t('settings.notifications.hint')}>
          <Switch size="md" checked={settings.notifications} aria-label={t('settings.notifications')} onChange={(notifications) => save({ notifications })} />
        </Row>
        <Row label={t('settings.sound')} hint={t('settings.sound.hint')}>
          <Switch size="md" checked={settings.soundEnabled} aria-label={t('settings.sound')} onChange={(soundEnabled) => save({ soundEnabled })} />
        </Row>
        <Row
          label={t('settings.template')}
          hint={t('settings.template.hint')}
          stack
        >
          <textarea
            className="hc-settings__textarea"
            aria-label={t('settings.template')}
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
              {t('settings.template.reset')}
            </Button>
          </div>
        </Row>
      </Section>

      <Section
        title={t('settings.models')}
        description={t('settings.models.desc')}
      >
        <AgentGroup agent="claude-code" />
        <Row label={t('settings.model')} hint={t('settings.model.hint', { model: defaultModelLabel })}>
          <SelectMenu
            label={t('settings.defaultModel')}
            value={settings.defaultModel}
            options={modelOptions.map((m) => ({ value: m.value, label: modelMenuLabel(m.value, modelOptions, defaultModelLabel) }))}
            isChecked={(value) => {
              const option = modelOptions.find((m) => m.value === value);
              return option ? isModelSelected(settings.defaultModel, option, modelOptions) : false;
            }}
            onChange={(defaultModel) => save({ defaultModel })}
          />
        </Row>
        <Row label="effort" hint={t('settings.effort.hint')}>
          <Segmented<'auto' | EffortLevel>
            aria-label={t('settings.effort.aria')}
            size="sm"
            value={settings.defaultEffort ?? 'auto'}
            options={[{ value: 'auto', label: t('common.auto') }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: effortLabel(e) }))]}
            onChange={(v) => save({ defaultEffort: v === 'auto' ? null : v })}
          />
        </Row>
        <AgentGroup agent="codex" />
        <Row label={t('settings.model')} hint={t('settings.codexModel.hint')}>
          <SelectMenu
            label={t('settings.codexModel')}
            value={settings.codexDefaultModel}
            options={codexModels.map((m) => ({ value: m.value, label: m.label }))}
            onChange={(codexDefaultModel) => save({ codexDefaultModel })}
          />
        </Row>
        <Row label="reasoning effort" hint={t('settings.codexEffort.hint')}>
          <Segmented<CodexEffortLevel>
            aria-label={t('settings.codexEffort.aria')}
            size="sm"
            value={settings.codexDefaultEffort}
            options={codexEfforts.map((e) => ({ value: e.value, label: effortLabel(e.value) }))}
            onChange={(codexDefaultEffort) => save({ codexDefaultEffort })}
          />
        </Row>
        <Row
          label={t('settings.codexPath')}
          hint={
            codexInfo?.enginePath
              ? t('settings.codexPath.hintInUse', { path: codexInfo.enginePath, version: codexInfo.version ?? '?' })
              : t('settings.codexPath.hintEmpty')
          }
        >
          <input
            type="text"
            className="hc-settings__text"
            aria-label={t('settings.codexPath')}
            data-testid="settings-codex-path"
            placeholder={t('settings.codexPath.placeholder')}
            spellCheck={false}
            value={codexPathDraft}
            onChange={(e) => setCodexPathDraft(e.target.value)}
            onBlur={commitCodexPath}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </Row>
        <AgentGroup agent="hermes" />
        <Row label={t('settings.hermes.label')} hint={t('settings.hermes.hint')}>
          <span className="hc-settings__fixed" data-testid="hermes-default">
            {hermesInfo?.defaultModel
              ? `${systemDefaultLabel()} (${hermesModelLabel(hermesInfo.defaultModel)}${hermesInfo.defaultProvider ? ` · ${hermesInfo.defaultProvider}` : ''})`
              : systemDefaultLabel()}
          </span>
        </Row>
      </Section>

      <Section title={t('settings.accounts')} description={t('settings.accounts.desc', { count: accounts.length, enabled: accounts.filter((a) => a.enabled).length })}>
        <Row
          label={t('settings.autoSwitch')}
          hint={
            settings.autoSwitchAccounts
              ? t('settings.autoSwitch.on')
              : t('settings.autoSwitch.off')
          }
        >
          <Switch
            size="md"
            checked={settings.autoSwitchAccounts}
            aria-label={t('settings.autoSwitch')}
            onChange={(autoSwitchAccounts) => save({ autoSwitchAccounts })}
          />
        </Row>
        <Row label={t('settings.poll')} hint={t('settings.poll.hint')}>
          <span className="hc-settings__range">
            <input
              type="range"
              min={USAGE_POLL_MIN_SEC}
              max={USAGE_POLL_MAX_SEC}
              step={30}
              aria-label={t('settings.poll.aria')}
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
        title={t('settings.shared')}
        description={t('settings.shared.desc', { dir: shared ? tildePath(shared.sourceDir, homeDir) : '~/.claude' })}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={relinking || accounts.length === 0}
            onClick={() => {
              setRelinking(true);
              void relinkShared()
                .then(setShared)
                .catch((err: unknown) => setError(t('settings.err.relink', { error: err instanceof Error ? err.message : String(err) })))
                .finally(() => setRelinking(false));
            }}
          >
            <GlyphRefresh width={13} height={13} />
            {t('settings.shared.relink')}
          </Button>
        }
      >
        <ul className="hc-settings__shared" aria-label={t('settings.shared.list')}>
          {(shared?.entries ?? []).map((entry) => {
            const states = Object.values(entry.byAccount);
            const linked = states.filter((st) => st === 'linked').length;
            const problem = states.find((st) => st === 'broken' || st === 'conflict');
            const tone = !entry.inSource ? 'muted' : problem ? 'warn' : linked === states.length && states.length > 0 ? 'ok' : 'muted';
            const text = !entry.inSource
              ? t('settings.shared.noSource')
              : states.length === 0
                ? t('settings.shared.noAccounts')
                : problem
                  ? `${t(STATE_KEY[problem])} · ${linked}/${states.length}`
                  : `${t(STATE_KEY.linked)} ${linked}/${states.length}`;
            return (
              <li key={entry.name} className="hc-settings__shared-row">
                <code className="hc-settings__shared-name">{entry.name}</code>
                <span className={`hc-settings__chip hc-settings__chip--${tone}`}>{text}</span>
              </li>
            );
          })}
          {shared === null ? <li className="hc-settings__shared-row hc-settings__muted">{t('common.loading')}</li> : null}
        </ul>
      </Section>

      <Section title={t('settings.data')}>
        <Row label={t('settings.dataFolder')} hint={dataDir ? tildePath(dataDir, homeDir) : ' '} hintMono>
          <Button variant="secondary" size="sm" onClick={() => void onOpenDataFolder().catch((err: unknown) => setError(String(err)))}>
            <GlyphFolderOpen width={13} height={13} />
            {t('common.open')}
          </Button>
        </Row>
        <Row label={t('settings.archived')} hint={archivedCount > 0 ? t('settings.archived.hint', { count: archivedCount }) : t('settings.archived.none')}>
          <Button variant="destructive" size="sm" disabled={archivedCount === 0} onClick={() => setConfirmDelete(true)}>
            {t('settings.archived.deleteAll')}
          </Button>
        </Row>
      </Section>

      <Modal
        open={confirmDelete}
        onClose={() => !deleting && setConfirmDelete(false)}
        role="alertdialog"
        title={t('settings.archived.confirmTitle')}
        dismissible={!deleting}
        width={420}
        actions={
          <>
            <Button variant="secondary" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              className="hc-btn--danger-fill"
              disabled={deleting}
              onClick={() => {
                setDeleting(true);
                void onDeleteArchived()
                  .then(() => setConfirmDelete(false))
                  .catch((err: unknown) => setError(t('settings.err.delete', { error: err instanceof Error ? err.message : String(err) })))
                  .finally(() => setDeleting(false));
              }}
            >
              {t('settings.archived.deleteAllConfirm')}
            </Button>
          </>
        }
      >
        <p className="hc-settings__confirm">
          {t('settings.archived.confirmBody', { count: archivedCount })}
        </p>
      </Modal>
    </div>
  );
}

/** Agent sub-header inside a settings card (logo + name). */
function AgentGroup({ agent }: { agent: AgentKind }) {
  return (
    <div className="hc-settings__group" role="heading" aria-level={3}>
      <AgentIcon kind={agent} size={15} />
      <span>{AGENTS[agent].name}</span>
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
  isChecked,
  testId,
}: {
  label: string;
  testId?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Which row stands for `value` (default: exact match); e.g. a stored full model id checks its alias row. */
  isChecked?: (optionValue: T) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const checked = (o: { value: T }) => (isChecked ? isChecked(o.value) : o.value === value);
  const current = options.find((o) => o.value === value) ?? options.find(checked);
  const sections: MenuSection[] = [
    {
      key: 'options',
      kind: 'radio',
      items: options.map((o) => ({ key: o.value, label: o.label, checked: checked(o), onSelect: () => onChange(o.value) })),
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
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hc-select__value">{current?.label ?? value}</span>
        <GlyphChevronDown />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} sections={sections} label={label} placement="bottom-end" width={260} />
    </>
  );
}
