import { describe, expect, it } from 'vitest';
import {
  CODEX_MODE_BY_PERMISSION,
  NOTE_CODEX_FEATURES_OFF,
  codexLaunchEnv,
  codexMcpServerNames,
  draftAgentDefaults,
  isCodexAutoReviewMode,
  isFullAccessMode,
  reconcileConfig,
  SETTABLE_CONFIG_CATEGORIES,
} from '../../src/core/agentDefaults';
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

describe('codexLaunchEnv', () => {
  const base = { model: 'gpt-6.1-sol', effort: 'high' as const };
  const modeOf = (permissionMode: Parameters<typeof codexLaunchEnv>[0]['permissionMode']) => {
    const r = codexLaunchEnv({ ...base, permissionMode });
    return r.ok ? r.env.INITIAL_AGENT_MODE : null;
  };

  it('builds CODEX_CONFIG JSON and INITIAL_AGENT_MODE from the fixed permission table', () => {
    expect(codexLaunchEnv({ ...base, permissionMode: 'default' })).toEqual({
      ok: true,
      env: { CODEX_CONFIG: '{"model":"gpt-6.1-sol","model_reasoning_effort":"high"}', INITIAL_AGENT_MODE: 'workspace-write' },
    });
    expect(modeOf('plan')).toBe('read-only');
    expect(modeOf('acceptEdits')).toBe('workspace-write');
    expect(modeOf('bypassPermissions')).toBe('agent-full-access');
  });

  it('never selects the auto-review `agent` mode (the adapter default)', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const) {
      expect(modeOf(mode)).not.toBe('agent');
      expect(CODEX_MODE_BY_PERMISSION[mode]).not.toBe('agent');
    }
    expect(modeOf('weird' as never)).toBe('workspace-write');
  });

  it('omits model / effort when null', () => {
    const r = codexLaunchEnv({ model: null, effort: null, permissionMode: 'default' });
    expect(r).toEqual({ ok: true, env: { CODEX_CONFIG: '{}', INITIAL_AGENT_MODE: 'workspace-write' } });
  });

  it('rejects models outside the id pattern (nothing reaches CODEX_CONFIG)', () => {
    for (const model of ['a"b', 'a\nb', 'a=b', 'a b', '', '-x', 'a'.repeat(65), 'm","approval_policy":"never']) {
      expect(codexLaunchEnv({ model, effort: null, permissionMode: 'default' })).toEqual({ ok: false, error: 'invalid-model' });
    }
  });

  it('accepts Codex-only efforts (ultra, max) from the Codex set', () => {
    for (const effort of ['max', 'ultra'] as const) {
      const res = codexLaunchEnv({ model: null, effort, permissionMode: 'default' });
      expect(res.ok && JSON.parse(res.env.CODEX_CONFIG)).toEqual({ model_reasoning_effort: effort });
    }
  });

  it('rejects unknown effort values', () => {
    expect(codexLaunchEnv({ model: null, effort: 'high"x' as never, permissionMode: 'default' })).toEqual({
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

  it('codex-acp 2.x mode ids: agent-full-access is full access; agent (Auto review) is flagged separately', () => {
    expect(isFullAccessMode({ id: 'agent-full-access', name: 'Full access' })).toBe(true);
    for (const m of [{ id: 'read-only', name: 'Read-only' }, { id: 'workspace-write', name: 'Workspace access' }, { id: 'agent', name: 'Auto review' }]) {
      expect(isFullAccessMode(m)).toBe(false);
    }
    expect(isCodexAutoReviewMode({ id: 'agent', name: 'Auto review' })).toBe(true);
    expect(isCodexAutoReviewMode({ id: 'x', name: 'Auto-review' })).toBe(true);
    for (const m of [{ id: 'workspace-write', name: 'Workspace access' }, { id: 'agent-full-access', name: 'Full access' }]) {
      expect(isCodexAutoReviewMode(m)).toBe(false);
    }
  });

  it('only model and thought_level config options are settable', () => {
    expect([...SETTABLE_CONFIG_CATEGORIES].sort()).toEqual(['model', 'thought_level']);
  });
});

describe('codexLaunchEnv noTools (노트 모드)', () => {
  it('turns off web search, the tool features and the named MCP servers', () => {
    const r = codexLaunchEnv({ model: 'gpt-6.1-sol', effort: null, permissionMode: 'plan', noTools: { mcpServers: ['docs', 'a b', 'x"y'] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.INITIAL_AGENT_MODE).toBe('read-only');
    const config = JSON.parse(r.env.CODEX_CONFIG);
    expect(config).toEqual({
      model: 'gpt-6.1-sol',
      web_search: 'disabled',
      features: Object.fromEntries(NOTE_CODEX_FEATURES_OFF.map((k) => [k, false])),
      mcp_servers: { docs: { enabled: false } },
    });
    for (const key of ['shell_tool', 'unified_exec', 'apply_patch_freeform', 'view_image', 'web_search_request', 'apps', 'plugins']) {
      expect(NOTE_CODEX_FEATURES_OFF).toContain(key);
    }
  });

  it('threads keep their config unchanged', () => {
    expect(codexLaunchEnv({ model: null, effort: null, permissionMode: 'plan' })).toEqual({ ok: true, env: { CODEX_CONFIG: '{}', INITIAL_AGENT_MODE: 'read-only' } });
    const none = codexLaunchEnv({ model: null, effort: null, permissionMode: 'plan', noTools: { mcpServers: [] } });
    expect(none.ok && JSON.parse(none.env.CODEX_CONFIG).mcp_servers).toBeUndefined();
  });

  it('reads MCP server names from config.toml table headers', () => {
    const toml = [
      'model = "x"',
      '[mcp_servers.docs]',
      'command = "npx"',
      '[mcp_servers.docs.env]',
      'A = "1"',
      '  [ mcp_servers."quoted-name" ]',
      "[mcp_servers.'single']",
      '[mcp_servers."has space"]',
      '[other.mcp_servers.nope]',
      '# [mcp_servers.commented]',
    ].join('\n');
    expect(codexMcpServerNames(toml)).toEqual(['docs', 'quoted-name', 'single']);
  });
});
