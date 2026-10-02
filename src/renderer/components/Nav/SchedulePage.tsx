import { useEffect, useMemo, useState } from 'react';
import { describeRepeat, formatHm, weekdayLabel } from '../../../core/schedule';
import { EFFORT_LEVELS } from '../../../shared/constants';
import type { Schedule, ScheduleInput, ScheduleMode, ScheduleRun, Weekday } from '../../../shared/nav';
import type { EffortLevel, ModelOption, Project, Thread } from '../../../shared/types';
import { invoke, on } from '../../api';
import { ipcErrorMessage } from '../../errors';
import { EFFORT_LABEL, permissionModeLabel } from '../Chat/ComposerControls';
import { Button, Modal, Pill, Segmented, Switch, type PillTone } from '../common';
import { PageHeader, PageSection } from './PageHeader';
import { formatDate, t, type MessageKey } from '../../../shared/i18n';

export interface SchedulePageProps {
  projects: Project[];
  threads: Thread[];
  models: ModelOption[];
  defaultModel: string;
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
}

type RepeatKind = ScheduleInput['repeat']['kind'];

interface FormState {
  projectId: string;
  prompt: string;
  model: string;
  permissionMode: ScheduleMode;
  effort: EffortLevel | null;
  kind: RepeatKind;
  /** `YYYY-MM-DD` (1회 only). */
  date: string;
  time: string;
  weekday: Weekday;
  enabled: boolean;
}

const MODES: readonly ScheduleMode[] = ['default', 'plan', 'acceptEdits'];
const KINDS: readonly { value: RepeatKind; label: MessageKey }[] = [
  { value: 'once', label: 'schedule.kind.once' },
  { value: 'daily', label: 'schedule.kind.daily' },
  { value: 'weekdays', label: 'schedule.kind.weekdays' },
  { value: 'weekly', label: 'schedule.kind.weekly' },
];
const RUN_STATUS: Record<ScheduleRun['status'], { label: MessageKey; tone: PillTone }> = {
  started: { label: 'schedule.run.started', tone: 'ok' },
  waiting: { label: 'status.waiting', tone: 'accent' },
  missed: { label: 'schedule.run.missed', tone: 'warn' },
  failed: { label: 'tool.failed', tone: 'crit' },
};
const RUNS_SHOWN = 5;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "9월 27일 (일) 09:00" / "Sep 27 (Sun) 09:00" in local time and the current language. */
export function formatWhen(ms: number): string {
  const d = new Date(ms);
  return `${formatDate(d, { month: 'short', day: 'numeric' })} (${weekdayLabel(d.getDay())}) ${formatHm(ms)}`;
}

/** Local `YYYY-MM-DD` + `HH:MM` -> epoch ms (null when either is malformed). */
function localTime(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])).getTime();
}

function blankForm(projects: readonly Project[], defaultModel: string): FormState {
  // Next full hour, today or tomorrow.
  const next = new Date();
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return {
    projectId: projects[0]?.id ?? '',
    prompt: '',
    model: defaultModel,
    permissionMode: 'default',
    effort: null,
    kind: 'daily',
    date: ymd(next),
    time: formatHm(next.getTime()),
    weekday: next.getDay() as Weekday,
    enabled: true,
  };
}

function formFrom(s: Schedule): FormState {
  const r = s.repeat;
  const onceAt = r.kind === 'once' ? new Date(r.at) : new Date();
  return {
    projectId: s.projectId,
    prompt: s.prompt,
    model: s.model,
    permissionMode: s.permissionMode,
    effort: s.effort,
    kind: r.kind,
    date: ymd(onceAt),
    time: r.kind === 'once' ? formatHm(r.at) : r.time,
    weekday: r.kind === 'weekly' ? r.weekday : (onceAt.getDay() as Weekday),
    enabled: s.enabled,
  };
}

function inputFrom(f: FormState): ScheduleInput | string {
  let repeat: ScheduleInput['repeat'];
  if (f.kind === 'once') {
    const at = localTime(f.date, f.time);
    if (at === null) return t('schedule.dateTimeRequired');
    repeat = { kind: 'once', at };
  } else if (f.kind === 'weekly') {
    repeat = { kind: 'weekly', weekday: f.weekday, time: f.time };
  } else {
    repeat = { kind: f.kind, time: f.time };
  }
  return {
    projectId: f.projectId,
    prompt: f.prompt,
    model: f.model,
    permissionMode: f.permissionMode,
    effort: f.effort,
    repeat,
    enabled: f.enabled,
  };
}

/** 예약: scheduled prompts that main starts as new threads at their time (list, create / edit form, run history). */
export function SchedulePage({ projects, threads, models, defaultModel, onBack, onOpenThread }: SchedulePageProps) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; form: FormState } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Schedule | null>(null);

  useEffect(() => {
    const off = on('schedule:updated', setSchedules);
    invoke('schedule:list')
      .then(setSchedules)
      .catch((err: unknown) => setListError(t('schedule.err.list', { error: ipcErrorMessage(err) })));
    return off;
  }, []);

  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const threadIds = useMemo(() => new Set(threads.map((t) => t.id)), [threads]);
  const modelOptions = models.length > 0 ? models : [{ value: 'default', label: 'Default' }];
  const modelLabel = (value: string) => modelOptions.find((m) => m.value === value)?.label ?? value;

  const patch = (p: Partial<FormState>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...p } } : e));
  const openNew = () => {
    setFormError(null);
    setEditing({ form: blankForm(projects, defaultModel) });
  };

  const save = () => {
    if (!editing) return;
    const input = inputFrom(editing.form);
    if (typeof input === 'string') {
      setFormError(input);
      return;
    }
    setSaving(true);
    setFormError(null);
    invoke('schedule:save', { ...(editing.id ? { id: editing.id } : {}), schedule: input })
      .then(() => setEditing(null))
      .catch((err: unknown) => setFormError(ipcErrorMessage(err)))
      .finally(() => setSaving(false));
  };

  const setEnabled = (s: Schedule, enabled: boolean) => {
    setListError(null);
    void invoke('schedule:setEnabled', { id: s.id, enabled }).catch((err: unknown) => setListError(ipcErrorMessage(err)));
  };

  const remove = (s: Schedule) => {
    setConfirmDelete(null);
    void invoke('schedule:delete', { id: s.id }).catch((err: unknown) => setListError(ipcErrorMessage(err)));
  };

  const form = editing?.form;

  return (
    <div className="hc-page" data-testid="schedule-page">
      <PageHeader
        title={t('nav.schedule')}
        lede={t('schedule.lede')}
        onBack={onBack}
        actions={
          projects.length > 0 && !editing ? (
            <Button size="sm" variant="primary" onClick={openNew}>
              {t('schedule.new')}
            </Button>
          ) : null
        }
      />

      {listError ? (
        <div className="hc-page__notice hc-page__notice--error" role="alert">
          {listError}
        </div>
      ) : null}

      {projects.length === 0 ? (
        <div className="hc-page__notice" role="status">
          {t('schedule.needProject')}
        </div>
      ) : null}

      {form ? (
        <PageSection title={editing?.id ? t('schedule.editTitle') : t('schedule.new')}>
          <form
            className="hc-page__card"
            aria-label={editing?.id ? t('schedule.editTitle') : t('schedule.new')}
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="hc-form">
              <label className="hc-form__label" htmlFor="hc-sched-project">
                {t('sidebar.projects')}
              </label>
              <div className="hc-form__field">
                <select
                  id="hc-sched-project"
                  className="hc-form__select"
                  value={form.projectId}
                  onChange={(e) => patch({ projectId: e.target.value })}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <label className="hc-form__label hc-form__label--top" htmlFor="hc-sched-prompt">
                {t('subagent.prompt')}
              </label>
              <textarea
                id="hc-sched-prompt"
                className="hc-form__textarea"
                value={form.prompt}
                placeholder={t('schedule.prompt.placeholder')}
                onChange={(e) => patch({ prompt: e.target.value })}
              />

              <label className="hc-form__label" htmlFor="hc-sched-model">
                {t('model.title')}
              </label>
              <div className="hc-form__field">
                <select id="hc-sched-model" className="hc-form__select" value={form.model} onChange={(e) => patch({ model: e.target.value })}>
                  {modelOptions.some((m) => m.value === form.model) ? null : <option value={form.model}>{form.model}</option>}
                  {modelOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t('schedule.effort')}
                  className="hc-form__select"
                  value={form.effort ?? ''}
                  onChange={(e) => patch({ effort: (e.target.value || null) as EffortLevel | null })}
                >
                  <option value="">{t('schedule.effort.default')}</option>
                  {EFFORT_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {EFFORT_LABEL[level]}
                    </option>
                  ))}
                </select>
              </div>

              <span className="hc-form__label">{t('mode.title')}</span>
              <div className="hc-form__field">
                <Segmented
                  aria-label={t('settings.defaultMode.aria')}
                  size="sm"
                  value={form.permissionMode}
                  onChange={(permissionMode) => patch({ permissionMode })}
                  options={MODES.map((m) => ({ value: m, label: permissionModeLabel(m) }))}
                />
                <span className="hc-form__hint">{t('schedule.noBypass')}</span>
              </div>

              <span className="hc-form__label">{t('schedule.repeat')}</span>
              <div className="hc-form__field">
                <Segmented aria-label={t('schedule.repeat')} size="sm" value={form.kind} onChange={(kind) => patch({ kind })} options={KINDS.map((k) => ({ value: k.value, label: t(k.label) }))} />
              </div>

              <span className="hc-form__label">{t('schedule.runAt')}</span>
              <div className="hc-form__field">
                {form.kind === 'once' ? (
                  <input
                    type="date"
                    aria-label={t('schedule.date')}
                    className="hc-form__input"
                    value={form.date}
                    onChange={(e) => patch({ date: e.target.value })}
                  />
                ) : null}
                {form.kind === 'weekly' ? (
                  <select
                    aria-label={t('schedule.weekday')}
                    className="hc-form__select"
                    value={form.weekday}
                    onChange={(e) => patch({ weekday: Number(e.target.value) as Weekday })}
                  >
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <option key={d} value={d}>
                        {weekdayLabel(d, 'long')}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  type="time"
                  aria-label={t('schedule.time')}
                  className="hc-form__input"
                  value={form.time}
                  required
                  onChange={(e) => patch({ time: e.target.value })}
                />
              </div>

              <span className="hc-form__label">{t('plugins.enabled')}</span>
              <div className="hc-form__field">
                <Switch checked={form.enabled} aria-label={t('schedule.enabled')} onChange={(enabled) => patch({ enabled })} />
              </div>
            </div>
            <div className="hc-form__footer">
              <span className="hc-form__error" role={formError ? 'alert' : undefined}>
                {formError}
              </span>
              <Button size="sm" variant="plain" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" type="submit" disabled={saving || !form.prompt.trim() || !form.projectId}>
                {saving ? t('notes.save.saving') : t('common.save')}
              </Button>
            </div>
          </form>
        </PageSection>
      ) : null}

      {schedules && schedules.length > 0 ? (
        <PageSection title={t('schedule.list')} meta={t('plugins.count', { count: schedules.length })}>
          <ul className="hc-page__card hc-page__list" aria-label={t('schedule.list')}>
            {schedules.map((s) => {
              const title = s.prompt.split('\n')[0]!.trim();
              return (
                <li key={s.id} className="hc-page__row" data-testid="schedule-row">
                  <div className="hc-page__row-main">
                    <div className="hc-page__row-title">
                      <span>{title}</span>
                    </div>
                    <div className="hc-page__row-sub">
                      <span>{projectName.get(s.projectId) ?? t('schedule.deletedProject')}</span>
                      <span>{describeRepeat(s.repeat)}</span>
                      <span>
                        {modelLabel(s.model)} · {permissionModeLabel(s.permissionMode)}
                      </span>
                      <span>{s.enabled && s.nextRunAt !== null ? t('schedule.nextRun', { when: formatWhen(s.nextRunAt) }) : t('schedule.off')}</span>
                    </div>
                    {s.runs.length > 0 ? (
                      <ul className="hc-runs" aria-label={t('schedule.runs')}>
                        {s.runs.slice(0, RUNS_SHOWN).map((run) => (
                          <li key={`${run.scheduledAt}-${run.at}-${run.status}`}>
                            <Pill tone={RUN_STATUS[run.status].tone}>
                              {t(RUN_STATUS[run.status].label)}
                              {run.missedCount && run.missedCount > 1 ? ` ${t('schedule.run.times', { count: run.missedCount })}` : ''}
                            </Pill>
                            <span>{formatWhen(run.scheduledAt)}</span>
                            {run.threadId && threadIds.has(run.threadId) ? (
                              <button type="button" className="hc-page__link" onClick={() => onOpenThread(run.threadId!)}>
                                {t('schedule.openThread')}
                              </button>
                            ) : null}
                            {run.error ? <span>{run.error}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <div className="hc-page__row-actions">
                    <Switch checked={s.enabled} aria-label={t('schedule.enabledAria', { title })} onChange={(enabled) => setEnabled(s, enabled)} />
                    <Button
                      size="sm"
                      variant="plain"
                      onClick={() => {
                        setFormError(null);
                        setEditing({ id: s.id, form: formFrom(s) });
                      }}
                    >
                      {t('schedule.edit')}
                    </Button>
                    <Button size="sm" variant="plain" onClick={() => setConfirmDelete(s)}>
                      {t('common.delete')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </PageSection>
      ) : schedules && !form && projects.length > 0 ? (
        <div className="hc-page__card">
          <div className="hc-page__empty">
            <p>{t('schedule.empty')}</p>
            <p>{t('schedule.empty.sub')}</p>
          </div>
        </div>
      ) : null}

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={t('schedule.delete.title')}
        role="alertdialog"
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => confirmDelete && remove(confirmDelete)}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p>{t('schedule.delete.body')}</p>
      </Modal>
    </div>
  );
}
