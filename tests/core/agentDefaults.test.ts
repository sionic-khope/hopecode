import { describe, expect, it } from 'vitest';
import { codexLaunchArgs, draftAgentDefaults, isFullAccessMode, reconcileConfig, SETTABLE_CONFIG_CATEGORIES } from '../../src/core/agentDefaults';
import type { AcpConfigOptionLite } from '../../src/shared/types';

const SETTINGS = {
  defaultModel: 'claude-opus-5-5',
  defaultEffort: 'high' as const,
  codexDefaultModel: 'gpt-6.1-sol',
  codexDefaultEffort: 'xhigh' as const,
};

describe('draftAgentDefaults', () => {
  it('picks per-agent defaults; hermes uses the system default', () => {
    expect(draftAgentDefaults('claude-code', SETTINGS)).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    expect(draftAgentDefaults('codex', SETTINGS)).toEqual({ model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(draftAgentDefaults('hermes', SETTINGS)).toEqual({ model: '', effort: null });
  });
});

describe('codexLaunchArgs', () => {
  const base = { model: 'gpt-6.1-sol', effort: 'high' as const };

  it('builds -c arguments from the fixed permission table', () => {
    expect(codexLaunchArgs({ ...base, permissionMode: 'default' })).toEqual({
      ok: true,
      args: ['-c', 'model="gpt-6.1-sol"', '-c', 'model_reasoning_effort="high"', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"'],
    });
    const tail = (mode: Parameters<typeof codexLaunchArgs>[0]['permissionMode']) => {
      const r = codexLaunchArgs({ ...base, permissionMode: mode });
      return r.ok ? r.args.slice(-4) : null;
    };
    expect(tail('plan')).toEqual(['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="read-only"']);
    expect(tail('acceptEdits')).toEqual(tail('default'));
    expect(tail('bypassPermissions')).toEqual(['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"']);
  });

  it('omits model / effort when null', () => {
    const r = codexLaunchArgs({ model: null, effort: null, permissionMode: 'default' });
    expect(r).toEqual({ ok: true, args: ['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"'] });
  });

  it('rejects models that could break out of the TOML string', () => {
    for (const model of ['a"b', 'a\nb', 'a=b', 'a b', '', '-x', 'a'.repeat(65), 'm"\nsandbox_mode="danger-full-access']) {
      expect(codexLaunchArgs({ model, effort: null, permissionMode: 'default' })).toEqual({ ok: false, error: 'invalid-model' });
    }
  });

  it('accepts Codex-only efforts (ultra, max) from the Codex set', () => {
    for (const effort of ['max', 'ultra'] as const) {
      const res = codexLaunchArgs({ model: null, effort, permissionMode: 'default' });
      expect(res.ok && res.args.slice(0, 2)).toEqual(['-c', `model_reasoning_effort="${effort}"`]);
    }
  });

  it('rejects unknown effort values', () => {
    expect(codexLaunchArgs({ model: null, effort: 'high"x' as never, permissionMode: 'default' })).toEqual({
      ok: false,
      error: 'invalid-effort',
    });
  });
});

describe('reconcileConfig', () => {
  const select = (id: string, category: string, currentValue: string, values: string[]): AcpConfigOptionLite => ({
    id,
    name: id,
    category,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  });
  const opts = [select('model', 'model', 'gpt-5', ['gpt-5', 'gpt-6.1-sol']), select('effort', 'thought_level', 'low', ['low', 'high'])];

  it('sets values that differ and are offered', () => {
    expect(reconcileConfig(opts, { model: 'gpt-6.1-sol', effort: 'high' })).toEqual({
      set: [
        { configId: 'model', value: 'gpt-6.1-sol' },
        { configId: 'effort', value: 'high' },
      ],
      missing: [],
    });
  });

  it('does nothing when already current or not wanted', () => {
    expect(reconcileConfig(opts, { model: 'gpt-5', effort: 'low' })).toEqual({ set: [], missing: [] });
    expect(reconcileConfig(opts, { model: null, effort: null })).toEqual({ set: [], missing: [] });
  });

  it('reports wanted values the agent does not offer', () => {
    expect(reconcileConfig(opts, { model: 'gpt-9', effort: 'max' })).toEqual({
      set: [],
      missing: [
        { category: 'model', wanted: 'gpt-9', current: 'gpt-5' },
        { category: 'thought_level', wanted: 'max', current: 'low' },
      ],
    });
  });

  it('ignores agents without that category or with boolean options', () => {
    expect(reconcileConfig([], { model: 'x', effort: 'high' })).toEqual({ set: [], missing: [] });
    const bool: AcpConfigOptionLite = { id: 'b', name: 'b', category: 'model', type: 'boolean', currentValue: true };
    expect(reconcileConfig([bool], { model: 'x', effort: null })).toEqual({ set: [], missing: [] });
  });
});

describe('isFullAccessMode / SETTABLE_CONFIG_CATEGORIES', () => {
  it('matches full-access-like ids or names only', () => {
    for (const m of [{ id: 'full-access', name: 'x' }, { id: 'x', name: 'Full Access' }, { id: 'dont_ask', name: "Don't ask" }, { id: 'yolo', name: 'y' }, { id: 'bypass', name: 'b' }]) {
      expect(isFullAccessMode(m)).toBe(true);
    }
    for (const m of [{ id: 'auto', name: 'Default' }, { id: 'read-only', name: 'Read Only' }, { id: 'accept_edits', name: 'Accept edits' }]) {
      expect(isFullAccessMode(m)).toBe(false);
    }
  });

  it('only model and thought_level config options are settable', () => {
    expect([...SETTABLE_CONFIG_CATEGORIES].sort()).toEqual(['model', 'thought_level']);
  });
});
