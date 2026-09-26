import { useEffect, useMemo, useState } from 'react';
import { WEEKDAY_LABELS, describeRepeat, formatHm } from '../../../core/schedule';
import { EFFORT_LEVELS } from '../../../shared/constants';
import type { Schedule, ScheduleInput, ScheduleMode, ScheduleRun, Weekday } from '../../../shared/nav';
import type { EffortLevel, ModelOption, Project, Thread } from '../../../shared/types';
import { invoke, on } from '../../api';
import { ipcErrorMessage } from '../../errors';
import { EFFORT_LABEL, PERMISSION_MODE_LABEL } from '../Chat/ComposerControls';
import { Button, Modal, Pill, Segmented, Switch, type PillTone } from '../common';
import { PageHeader, PageSection } from './PageHeader';

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
const KINDS: readonly { value: RepeatKind; label: string }[] = [
  { value: 'once', label: '1회' },
  { value: 'daily', label: '매일' },
  { value: 'weekdays', label: '평일' },
  { value: 'weekly', label: '매주' },
];
const RUN_STATUS: Record<ScheduleRun['status'], { label: string; tone: PillTone }> = {
  started: { label: '실행됨', tone: 'ok' },
  waiting: { label: '대기 중', tone: 'accent' },
  missed: { label: '놓침', tone: 'warn' },
  failed: { label: '실패', tone: 'crit' },
};
const RUNS_SHOWN = 5;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "9월 27일 (일) 09:00" in local time. */
export function formatWhen(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[d.getDay()]}) ${formatHm(ms)}`;
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
    if (at === null) return '날짜와 시각을 입력하세요';
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
      .catch((err: unknown) => setListError(`예약을 불러오지 못했습니다: ${ipcErrorMessage(err)}`));
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
        title="예약"
        lede="정한 시각에 새 스레드를 만들고 프롬프트를 보냅니다. 앱이 꺼져 있던 동안 지난 예약은 실행하지 않고 놓침으로 남깁니다."
        onBack={onBack}
        actions={
          projects.length > 0 && !editing ? (
            <Button size="sm" variant="primary" onClick={openNew}>
              새 예약
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
          예약하려면 먼저 프로젝트를 추가하세요. 새 채팅에서 폴더를 고르면 프로젝트가 됩니다.
        </div>
      ) : null}

      {form ? (
        <PageSection title={editing?.id ? '예약 편집' : '새 예약'}>
          <form
            className="hc-page__card"
            aria-label={editing?.id ? '예약 편집' : '새 예약'}
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="hc-form">
              <label className="hc-form__label" htmlFor="hc-sched-project">
                프로젝트
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
                프롬프트
              </label>
              <textarea
                id="hc-sched-prompt"
                className="hc-form__textarea"
                value={form.prompt}
                placeholder="예: 밤사이 실패한 테스트를 확인하고 원인을 정리해 주세요"
                onChange={(e) => patch({ prompt: e.target.value })}
              />

              <label className="hc-form__label" htmlFor="hc-sched-model">
                모델
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
                  aria-label="추론 강도"
                  className="hc-form__select"
                  value={form.effort ?? ''}
                  onChange={(e) => patch({ effort: (e.target.value || null) as EffortLevel | null })}
                >
                  <option value="">추론 강도 기본값</option>
                  {EFFORT_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {EFFORT_LABEL[level]}
                    </option>
                  ))}
                </select>
              </div>

              <span className="hc-form__label">권한</span>
              <div className="hc-form__field">
                <Segmented
                  aria-label="권한 모드"
                  size="sm"
                  value={form.permissionMode}
                  onChange={(permissionMode) => patch({ permissionMode })}
                  options={MODES.map((m) => ({ value: m, label: PERMISSION_MODE_LABEL[m] }))}
                />
                <span className="hc-form__hint">예약에서는 전체 액세스를 쓸 수 없습니다</span>
              </div>

              <span className="hc-form__label">반복</span>
              <div className="hc-form__field">
                <Segmented aria-label="반복" size="sm" value={form.kind} onChange={(kind) => patch({ kind })} options={KINDS} />
              </div>

              <span className="hc-form__label">실행 시각</span>
              <div className="hc-form__field">
                {form.kind === 'once' ? (
                  <input
                    type="date"
                    aria-label="날짜"
                    className="hc-form__input"
                    value={form.date}
                    onChange={(e) => patch({ date: e.target.value })}
                  />
                ) : null}
                {form.kind === 'weekly' ? (
                  <select
                    aria-label="요일"
                    className="hc-form__select"
                    value={form.weekday}
                    onChange={(e) => patch({ weekday: Number(e.target.value) as Weekday })}
                  >
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <option key={d} value={d}>
                        {WEEKDAY_LABELS[d]}요일
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  type="time"
                  aria-label="시각"
                  className="hc-form__input"
                  value={form.time}
                  required
                  onChange={(e) => patch({ time: e.target.value })}
                />
              </div>

              <span className="hc-form__label">활성</span>
              <div className="hc-form__field">
                <Switch checked={form.enabled} aria-label="예약 활성" onChange={(enabled) => patch({ enabled })} />
              </div>
            </div>
            <div className="hc-form__footer">
              <span className="hc-form__error" role={formError ? 'alert' : undefined}>
                {formError}
              </span>
              <Button size="sm" variant="plain" onClick={() => setEditing(null)}>
                취소
              </Button>
              <Button size="sm" variant="primary" type="submit" disabled={saving || !form.prompt.trim() || !form.projectId}>
                {saving ? '저장 중…' : '저장'}
              </Button>
            </div>
          </form>
        </PageSection>
      ) : null}

      {schedules && schedules.length > 0 ? (
        <PageSection title="예약 목록" meta={`${schedules.length}개`}>
          <ul className="hc-page__card hc-page__list" aria-label="예약 목록">
            {schedules.map((s) => {
              const title = s.prompt.split('\n')[0]!.trim();
              return (
                <li key={s.id} className="hc-page__row" data-testid="schedule-row">
                  <div className="hc-page__row-main">
                    <div className="hc-page__row-title">
                      <span>{title}</span>
                    </div>
                    <div className="hc-page__row-sub">
                      <span>{projectName.get(s.projectId) ?? '삭제된 프로젝트'}</span>
                      <span>{describeRepeat(s.repeat)}</span>
                      <span>
                        {modelLabel(s.model)} · {PERMISSION_MODE_LABEL[s.permissionMode]}
                      </span>
                      <span>{s.enabled && s.nextRunAt !== null ? `다음 실행 ${formatWhen(s.nextRunAt)}` : '꺼짐'}</span>
                    </div>
                    {s.runs.length > 0 ? (
                      <ul className="hc-runs" aria-label="실행 이력">
                        {s.runs.slice(0, RUNS_SHOWN).map((run) => (
                          <li key={`${run.scheduledAt}-${run.at}-${run.status}`}>
                            <Pill tone={RUN_STATUS[run.status].tone}>
                              {RUN_STATUS[run.status].label}
                              {run.missedCount && run.missedCount > 1 ? ` ${run.missedCount}회` : ''}
                            </Pill>
                            <span>{formatWhen(run.scheduledAt)}</span>
                            {run.threadId && threadIds.has(run.threadId) ? (
                              <button type="button" className="hc-page__link" onClick={() => onOpenThread(run.threadId!)}>
                                스레드 열기
                              </button>
                            ) : null}
                            {run.error ? <span>{run.error}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <div className="hc-page__row-actions">
                    <Switch checked={s.enabled} aria-label={`${title} 활성`} onChange={(enabled) => setEnabled(s, enabled)} />
                    <Button
                      size="sm"
                      variant="plain"
                      onClick={() => {
                        setFormError(null);
                        setEditing({ id: s.id, form: formFrom(s) });
                      }}
                    >
                      편집
                    </Button>
                    <Button size="sm" variant="plain" onClick={() => setConfirmDelete(s)}>
                      삭제
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
            <p>아직 예약이 없습니다</p>
            <p>매일 아침 점검, 평일 리포트 같은 반복 작업을 예약해 두세요.</p>
          </div>
        </div>
      ) : null}

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="예약을 삭제할까요?"
        role="alertdialog"
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              취소
            </Button>
            <Button variant="destructive" onClick={() => confirmDelete && remove(confirmDelete)}>
              삭제
            </Button>
          </>
        }
      >
        <p>이미 만들어진 스레드는 남습니다.</p>
      </Modal>
    </div>
  );
}
