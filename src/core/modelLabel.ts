import type { ModelOption } from '../shared/types';

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/**
 * Display name for a model id reported by the SDK (`claude-opus-5-5` -> `Opus 5.5`, `claude-fable-5` -> `Fable 5`).
 * An exact `models:list` match wins; otherwise the family and version are derived from the id.
 * Unknown ids are returned unchanged.
 */
export function modelLabel(model: string, options: readonly ModelOption[] = []): string {
  const exact = options.find((o) => o.value === model);
  if (exact) return exact.label;

  const id = model.toLowerCase().replace(/\[.*\]$/, '');
  const family = FAMILIES.find((f) => id.includes(f));
  if (!family) return model;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  // Version digits right after the family (`opus-5-5`, `sonnet-5`); date suffixes (8 digits) are dropped.
  const m = new RegExp(`${family}-(\\d{1,2})(?:-(\\d{1,2}))?(?=$|-)`).exec(id);
  if (!m) return name;
  return m[2] ? `${name} ${m[1]}.${m[2]}` : `${name} ${m[1]}`;
}
