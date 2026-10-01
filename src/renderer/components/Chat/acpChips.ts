// What the composer's agent-specific chips show (plan 2.11): Codex model / effort from the session's ACP config
// options (the built-in label table before the first session), Hermes' read-only "시스템 기본값" label and its
// ACP session modes. Pure, so the chips stay thin.
import { codexModelLabel } from '../../../core/modelDisplay';
import { CODEX_EFFORT_LEVELS, CODEX_MODEL_LABELS } from '../../../shared/constants';
import type { AcpConfigOptionLite, AcpControls, CodexEffortLevel, Thread } from '../../../shared/types';

/** Labels of Claude's levels plus Codex's `ultra` (CodexEffortLevel is the superset). */
export const EFFORT_LABEL: Record<CodexEffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

export const SYSTEM_DEFAULT_LABEL = '시스템 기본값';

type SelectOption = Extract<AcpConfigOptionLite, { type: 'select' }>;

export interface ChipChoice {
  value: string;
  label: string;
  description?: string;
}

/** The session's select option of a category (`model`, `thought_level`), or null. */
export function selectConfigOption(controls: AcpControls | null | undefined, category: string): SelectOption | null {
  const option = controls?.configOptions.find((o) => o.category === category && o.type === 'select');
  return option && option.type === 'select' ? option : null;
}

export const isCodexEffort = (v: string): v is CodexEffortLevel => (CODEX_EFFORT_LEVELS as readonly string[]).includes(v);

/** Effort value label: the app's names for known levels, else the agent's own name, else the value. */
export function effortValueLabel(value: string, option?: SelectOption | null): string {
  if (isCodexEffort(value)) return EFFORT_LABEL[value];
  return option?.options.find((o) => o.value === value)?.name ?? value;
}

/** Codex model rows before a session reported its own: the configured value plus the built-in table. */
export function codexFallbackModels(current: string): ChipChoice[] {
  const values = Object.keys(CODEX_MODEL_LABELS);
  if (current && !values.includes(current)) values.unshift(current);
  return values.map((value) => ({ value, label: codexModelLabel(value) }));
}

/** Newest Codex thread's reported option of a category (its list is what the user's Codex offers), or null. */
export function latestCodexModelOption(threads: readonly Thread[], category = 'model'): SelectOption | null {
  let best: { option: SelectOption; at: number } | null = null;
  for (const t of threads) {
    if (t.agent !== 'codex') continue;
    const option = selectConfigOption(t.acp?.controls, category);
    if (option && option.options.length > 0 && (!best || t.updatedAt > best.at)) best = { option, at: t.updatedAt };
  }
  return best?.option ?? null;
}

/** Model rows for a Codex draft / the settings select: the last reported list, else the fallback table. */
export function codexModelChoices(threads: readonly Thread[], current: string): ChipChoice[] {
  const option = latestCodexModelOption(threads);
  if (!option) return codexFallbackModels(current);
  const rows: ChipChoice[] = option.options.map((o) => ({ value: o.value, label: codexModelLabel(o.value, [option]), description: o.description }));
  if (current && !rows.some((r) => r.value === current)) rows.unshift({ value: current, label: codexModelLabel(current) });
  return rows;
}

/**
 * Codex effort rows (draft / settings): the last session-reported thought_level list (values the app can pass to
 * codex `-c`), else Codex's own set. Never Claude's set.
 */
export function codexEffortChoices(threads: readonly Thread[]): { value: CodexEffortLevel; label: string }[] {
  const reported = latestCodexModelOption(threads, 'thought_level')?.options.map((o) => o.value).filter(isCodexEffort) ?? [];
  const values = reported.length > 0 ? reported : CODEX_EFFORT_LEVELS;
  return values.map((e) => ({ value: e, label: EFFORT_LABEL[e] }));
}

export interface CodexChipState {
  modelLabel: string;
  effortLabel: string | null;
  /** null: no session has reported its options yet (the chip is read-only until then). */
  modelConfigId: string | null;
  effortConfigId: string | null;
  models: ChipChoice[];
  efforts: ChipChoice[];
  model: string;
  effort: string | null;
}

/** Codex thread chip: the session's current values when reported, else the thread's stored model / effort. */
export function codexThreadChip(thread: Pick<Thread, 'model' | 'effort' | 'acp'>): CodexChipState {
  const controls = thread.acp?.controls ?? null;
  const modelOption = selectConfigOption(controls, 'model');
  const effortOption = selectConfigOption(controls, 'thought_level');
  const model = modelOption?.currentValue || thread.model;
  const effort = effortOption?.currentValue || thread.effort || null;
  return {
    model,
    effort,
    modelLabel: model ? codexModelLabel(model, controls?.configOptions ?? []) : SYSTEM_DEFAULT_LABEL,
    effortLabel: effort ? effortValueLabel(effort, effortOption) : null,
    modelConfigId: modelOption?.id ?? null,
    effortConfigId: effortOption?.id ?? null,
    models: modelOption ? modelOption.options.map((o) => ({ value: o.value, label: o.name, description: o.description })) : [],
    efforts: effortOption ? effortOption.options.map((o) => ({ value: o.value, label: effortValueLabel(o.value, effortOption), description: o.description })) : [],
  };
}

/** Hermes model label: `시스템 기본값 · <reported>` or just `시스템 기본값` (the app never picks Hermes' model). */
export function hermesModelLabel(reportedModel: string | null | undefined): string {
  const m = reportedModel?.trim();
  return m ? `${SYSTEM_DEFAULT_LABEL} · ${m}` : SYSTEM_DEFAULT_LABEL;
}

export interface ModeChipState {
  label: string;
  currentModeId: string | null;
  modes: ChipChoice[];
}

/** Hermes mode chip: the session's modes (pending choice wins while no session is open), or null when none. */
export function agentModeChip(acp: Thread['acp']): ModeChipState | null {
  const controls = acp?.controls;
  if (!controls || controls.modes.length === 0) return null;
  const currentModeId = acp?.pendingModeId ?? controls.currentModeId;
  const current = controls.modes.find((m) => m.id === currentModeId);
  return {
    label: current?.name ?? currentModeId ?? '모드',
    currentModeId,
    modes: controls.modes.map((m) => ({ value: m.id, label: m.name, description: m.description })),
  };
}
