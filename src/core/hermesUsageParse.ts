// `hermes usage --json` stdout -> AgentUsageSnapshot (plan 0.3 / 2.8). Pure; unknown keys are ignored.
// Schema (hermes_cli/subcommands/usage.py, "keep the keys stable"): { provider, source, title, plan, fetched_at (ISO),
// windows: [{ label, used_percent, resets_at (ISO|null), detail }], details: string[], unavailable_reason }.
import type { AgentKind, AgentUsageSnapshot, AgentUsageWindow } from '../shared/types';

const MAX_TEXT = 120;
const MAX_WINDOWS = 8;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, MAX_TEXT) : null);

function isoMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function parseWindow(v: unknown): AgentUsageWindow | null {
  if (typeof v !== 'object' || v === null) return null;
  const w = v as Record<string, unknown>;
  const label = str(w.label);
  const used = typeof w.used_percent === 'number' && Number.isFinite(w.used_percent) ? w.used_percent : null;
  if (!label || used === null) return null;
  return { label, usedPercent: Math.min(100, Math.max(0, used)), resetsAt: isoMs(w.resets_at), detail: str(w.detail) };
}

/**
 * null = no usable usage (malformed JSON, `unavailable_reason` set, or no valid window): the statusline hides the
 * meters. `now` stands in for a missing / unparseable `fetched_at`.
 */
export function parseHermesUsage(text: string, agent: AgentKind, now: number): AgentUsageSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  if (str(root.unavailable_reason)) return null;
  const windows = Array.isArray(root.windows)
    ? root.windows.map(parseWindow).filter((w): w is AgentUsageWindow => w !== null).slice(0, MAX_WINDOWS)
    : [];
  if (windows.length === 0) return null;
  return {
    agent,
    provider: str(root.provider),
    title: str(root.title),
    plan: str(root.plan),
    windows,
    fetchedAt: isoMs(root.fetched_at) ?? now,
  };
}
