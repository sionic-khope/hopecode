import type { ModelOption } from '../shared/types';

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

const hasVersion = (label: string) => /\d/.test(label);

/**
 * Display name for a model id reported by the SDK (`claude-fable-5-1` -> `Fable 5.1`, `claude-haiku-4-5-20251001`
 * -> `Haiku 4.5`). The SDK's own label wins: a `models:list` row whose `value` is the id, or (for a concrete id) whose
 * `resolvedModel` is the id and whose label carries a version. Otherwise family and version are derived from the id.
 * Unknown ids are returned unchanged.
 */
export function modelLabel(model: string, options: readonly ModelOption[] = []): string {
  const exact = options.find((o) => o.value === model);
  if (exact) return exact.label;
  // `claude-opus-5-5` is reported as the resolvedModel of the `opus` row ("Opus 5.5"); the `default` row's label
  // ("Default (recommended)") never names a model.
  const resolved = options.find((o) => o.value !== 'default' && o.resolvedModel === model && hasVersion(o.label));
  if (resolved) return resolved.label;

  const id = model.toLowerCase().replace(/\[.*\]$/, '');
  const family = FAMILIES.find((f) => id.includes(f));
  if (!family) return model;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  // Version digits right after the family (`opus-5-5`, `sonnet-5`); date suffixes (8 digits) are dropped.
  const m = new RegExp(`${family}-(\\d{1,2})(?:-(\\d{1,2}))?(?=$|-)`).exec(id);
  if (!m) return name;
  return m[2] ? `${name} ${m[1]}.${m[2]}` : `${name} ${m[1]}`;
}
