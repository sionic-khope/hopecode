// Human model names for the composer / statusline: always a concrete, versioned name ("Fable 5"), never the
// bare alias ("Default", "Fable") the SDK accepts as a value.
import type { ModelOption } from '../shared/types';
import { modelLabel } from './modelLabel';

/** Versioned names of the CLI model aliases (used until the SDK reports something more specific). */
export const MODEL_ALIAS_LABEL: Readonly<Record<string, string>> = {
  fable: 'Fable 5',
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5',
};

/** What `default` runs as when no session has reported it yet. */
export const FALLBACK_DEFAULT_MODEL_LABEL = 'Fable 5';

const hasVersion = (label: string) => /\d/.test(label);

/**
 * Concrete name for a model value: the id a live session resolved wins; `default` becomes `defaultLabel`;
 * aliases get their version; full ids go through modelLabel; an unknown value falls back to its option label.
 */
export function concreteModelLabel(
  value: string,
  options: readonly ModelOption[],
  opts: { resolvedModel?: string | null; defaultLabel?: string } = {},
): string {
  if (opts.resolvedModel) {
    const resolved = modelLabel(opts.resolvedModel, []);
    if (hasVersion(resolved)) return resolved;
    // setModel() records the alias itself (`sonnet`) until the next session reports the full id.
    const alias = MODEL_ALIAS_LABEL[opts.resolvedModel.toLowerCase()];
    if (alias) return alias;
  }
  if (value === 'default') return opts.defaultLabel ?? FALLBACK_DEFAULT_MODEL_LABEL;
  const option = options.find((o) => o.value === value);
  if (option && hasVersion(option.label)) return option.label;
  const alias = MODEL_ALIAS_LABEL[value.toLowerCase()];
  if (alias) return alias;
  const derived = modelLabel(value, []);
  if (derived !== value) return derived;
  return option?.label ?? value;
}

/** Menu row label: `기본 (Fable 5)` for the default entry, the concrete name otherwise. */
export function modelMenuLabel(value: string, options: readonly ModelOption[], defaultLabel?: string): string {
  if (value === 'default') return `기본 (${defaultLabel ?? FALLBACK_DEFAULT_MODEL_LABEL})`;
  return concreteModelLabel(value, options);
}

/** What `default` resolved to most recently, from threads whose sessions reported it. */
export function defaultModelLabelFrom(
  threads: readonly { model: string; resolvedModel: string | null; updatedAt: number }[],
): string {
  let best: { resolvedModel: string; updatedAt: number } | null = null;
  for (const t of threads) {
    if (t.model !== 'default' || !t.resolvedModel) continue;
    if (!best || t.updatedAt > best.updatedAt) best = { resolvedModel: t.resolvedModel, updatedAt: t.updatedAt };
  }
  return best ? modelLabel(best.resolvedModel, []) : FALLBACK_DEFAULT_MODEL_LABEL;
}
