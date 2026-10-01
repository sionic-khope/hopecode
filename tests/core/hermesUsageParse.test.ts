import { describe, expect, it } from 'vitest';
import { parseHermesUsage } from '../../src/core/hermesUsageParse';

const NOW = 1_800_000_000_000;

const sample = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    provider: 'anthropic',
    source: 'oauth',
    title: 'Claude Max',
    plan: 'max',
    fetched_at: '2026-10-01T10:00:00Z',
    windows: [
      { label: 'Current session', used_percent: 42.5, resets_at: '2026-10-01T15:00:00Z', detail: null },
      { label: 'Current week', used_percent: 130, resets_at: null, detail: 'all models' },
    ],
    details: ['x'],
    unavailable_reason: null,
    extra_key: { ignored: true },
    ...over,
  });

describe('parseHermesUsage', () => {
  it('maps the stable schema, clamps used_percent, ignores unknown keys', () => {
    expect(parseHermesUsage(sample(), 'hermes', NOW)).toEqual({
      agent: 'hermes',
      provider: 'anthropic',
      title: 'Claude Max',
      plan: 'max',
      fetchedAt: Date.parse('2026-10-01T10:00:00Z'),
      windows: [
        { label: 'Current session', usedPercent: 42.5, resetsAt: Date.parse('2026-10-01T15:00:00Z'), detail: null },
        { label: 'Current week', usedPercent: 100, resetsAt: null, detail: 'all models' },
      ],
    });
    const neg = parseHermesUsage(sample({ windows: [{ label: 'w', used_percent: -5 }] }), 'hermes', NOW);
    expect(neg?.windows[0]?.usedPercent).toBe(0);
  });

  it('missing / bad fetched_at falls back to now', () => {
    expect(parseHermesUsage(sample({ fetched_at: 'nope' }), 'hermes', NOW)?.fetchedAt).toBe(NOW);
  });

  it('unavailable_reason, no valid windows, or malformed JSON -> null', () => {
    expect(parseHermesUsage(sample({ unavailable_reason: 'no usage endpoint', windows: [] }), 'hermes', NOW)).toBeNull();
    expect(parseHermesUsage(sample({ windows: [{ label: 'x' }, { used_percent: 3 }, null] }), 'hermes', NOW)).toBeNull();
    expect(parseHermesUsage(sample({ windows: 'x' }), 'hermes', NOW)).toBeNull();
    expect(parseHermesUsage('No account usage available', 'hermes', NOW)).toBeNull();
    expect(parseHermesUsage('[]', 'hermes', NOW)).toBeNull();
    expect(parseHermesUsage('', 'hermes', NOW)).toBeNull();
  });
});
