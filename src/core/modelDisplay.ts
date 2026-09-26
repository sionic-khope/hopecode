// Human model names for the composer / statusline: always a concrete, versioned name ("Fable 5.1"), never the
// bare alias ("Default", "Fable") the SDK accepts as a value. Labels the SDK reported (models:list) win over the
// built-in alias table, which only covers the time before the first report.
import type { ModelOption } from '../shared/types';
import { modelLabel } from './modelLabel';

/** Versioned names of the CLI model aliases (used until the SDK reports something more specific). */
export const MODEL_ALIAS_LABEL: Readonly<Record<string, string>> = {
  fable: 'Fable 5.1',
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5',
};

/** What `default` runs as when neither the SDK nor a session has reported it yet. */
export const FALLBACK_DEFAULT_MODEL_LABEL = 'Fable 5.1';

const hasVersion = (label: string) => /\d/.test(label);

/** Versioned label of an option row: its own label, else the label of the model it resolves to. */
function optionLabel(option: ModelOption | undefined, options: readonly ModelOption[]): string | null {
  if (!option) return null;
  if (option.value !== 'default' && hasVersion(option.label)) return option.label;
  if (option.resolvedModel) {
    const resolved = modelLabel(option.resolvedModel, options.filter((o) => o !== option));
    if (hasVersion(resolved)) return resolved;
  }
  return null;
}

/**
 * Concrete name for a model value: the id a live session resolved wins; `default` becomes `defaultLabel`;
 * SDK option labels come next; aliases get their version; full ids go through modelLabel; an unknown value falls
 * back to its option label.
 */
export function concreteModelLabel(
  value: string,
  options: readonly ModelOption[],
  opts: { resolvedModel?: string | null; defaultLabel?: string } = {},
): string {
  if (opts.resolvedModel) {
    const resolved = modelLabel(opts.resolvedModel, options.filter((o) => o.value !== 'default'));
    if (hasVersion(resolved)) return resolved;
    // setModel() records the alias itself (`sonnet`) until the next session reports the full id.
    const aliasOption = optionLabel(
      options.find((o) => o.value === opts.resolvedModel),
      options,
    );
    if (aliasOption) return aliasOption;
    const alias = MODEL_ALIAS_LABEL[opts.resolvedModel.toLowerCase()];
    if (alias) return alias;
  }
  if (value === 'default') return opts.defaultLabel ?? defaultModelLabelFromOptions(options) ?? FALLBACK_DEFAULT_MODEL_LABEL;
  const option = options.find((o) => o.value === value);
  const fromOption = optionLabel(option, options);
  if (fromOption) return fromOption;
  const alias = MODEL_ALIAS_LABEL[value.toLowerCase()];
  if (alias) return alias;
  const derived = modelLabel(value, []);
  if (derived !== value) return derived;
  return option?.label ?? value;
}

/** Menu row label: `기본 (Fable 5.1)` for the default entry, the concrete name otherwise. */
export function modelMenuLabel(value: string, options: readonly ModelOption[], defaultLabel?: string): string {
  if (value === 'default') return `기본 (${defaultLabel ?? defaultModelLabelFromOptions(options) ?? FALLBACK_DEFAULT_MODEL_LABEL})`;
  return concreteModelLabel(value, options);
}

/** What the SDK's `default` row resolves to (ModelInfo.resolvedModel), as a versioned name; null when unknown. */
export function defaultModelLabelFromOptions(options: readonly ModelOption[]): string | null {
  const row = options.find((o) => o.value === 'default');
  if (!row?.resolvedModel) return null;
  const label = modelLabel(row.resolvedModel, options.filter((o) => o.value !== 'default'));
  return hasVersion(label) ? label : null;
}

/**
 * What `default` runs as: the SDK's model list (startup probe / live session) first, then the newest thread
 * whose session reported it, then the fallback.
 */
export function defaultModelLabelFrom(
  threads: readonly { model: string; resolvedModel: string | null; updatedAt: number }[],
  options: readonly ModelOption[] = [],
): string {
  const fromOptions = defaultModelLabelFromOptions(options);
  if (fromOptions) return fromOptions;
  let best: { resolvedModel: string; updatedAt: number } | null = null;
  for (const t of threads) {
    if (t.model !== 'default' || !t.resolvedModel) continue;
    if (!best || t.updatedAt > best.updatedAt) best = { resolvedModel: t.resolvedModel, updatedAt: t.updatedAt };
  }
  return best ? modelLabel(best.resolvedModel, []) : FALLBACK_DEFAULT_MODEL_LABEL;
}
