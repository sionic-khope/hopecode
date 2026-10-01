// Per-agent draft defaults, codex-acp launch env, Codex mode ids and post-open config reconciliation (plan 2.11 / 2.15).
// Pure.
import { CODEX_EFFORT_LEVELS, CODEX_MODEL_PATTERN } from '../shared/constants';
import type { AcpModeLite, UiPermissionMode } from '../shared/types';
import type { CodexLaunchEnvFn, DraftAgentDefaultsFn, ReconcileConfigFn } from './acpTypes';

/** Codex's own effort set (includes `ultra`), never Claude's. */
const CODEX_EFFORTS: ReadonlySet<string> = new Set<string>(CODEX_EFFORT_LEVELS);

/** ACP session config categories the composer may set (`thread:setAgentConfig`); everything else is refused. */
export const SETTABLE_CONFIG_CATEGORIES: ReadonlySet<string> = new Set(['model', 'thought_level']);

const FULL_ACCESS_MODE = /full|danger|dont_ask|bypass|yolo/i;

/** An ACP mode whose id or name reads like "skip every approval" (needs the bypassPermissions confirm). */
export function isFullAccessMode(mode: Pick<AcpModeLite, 'id' | 'name'>): boolean {
  return FULL_ACCESS_MODE.test(mode.id) || FULL_ACCESS_MODE.test(mode.name);
}

export const draftAgentDefaults: DraftAgentDefaultsFn = (agent, settings) => {
  switch (agent) {
    case 'codex':
      return { model: settings.codexDefaultModel, effort: settings.codexDefaultEffort };
    case 'hermes':
      return { model: '', effort: null };
    default:
      return { model: settings.defaultModel, effort: settings.defaultEffort };
  }
};

/**
 * App permission chip -> codex-acp 2.x session mode id (`INITIAL_AGENT_MODE`, `session/set_mode`). Fixed table, no
 * user text. `agent` (Auto review: an automatic reviewer approves on the user's behalf) is never chosen by the app.
 */
export const CODEX_MODE_BY_PERMISSION: Readonly<Record<UiPermissionMode, string>> = {
  default: 'workspace-write',
  plan: 'read-only',
  acceptEdits: 'workspace-write',
  bypassPermissions: 'agent-full-access',
};

/** codex-acp's `agent` mode (approvalsReviewer auto_review); the app treats it as an unconfirmed escalation. */
export function isCodexAutoReviewMode(mode: Pick<AcpModeLite, 'id' | 'name'>): boolean {
  return mode.id === 'agent' || /auto[-_ ]?review/i.test(mode.id) || /auto[-_ ]?review/i.test(mode.name);
}

/**
 * Codex config of a 노트 모드 session (`noTools`): every tool family Codex 0.159 can switch off by config. Keys were
 * read from the installed `codex-cli 0.159.2` binary (feature table, `ConfigToml.web_search`, `WebSearchMode`
 * `disabled|cached|indexed|live`, `McpServerConfig.enabled`). There is no key that removes apply_patch for every model
 * (`apply_patch_freeform` only turns off the freeform variant), and MCP servers can only be disabled by name: the
 * runner (noteAi.ts) also cancels the turn on the first tool call, whatever these keys leave on.
 */
export const NOTE_CODEX_FEATURES_OFF: readonly string[] = [
  'shell_tool',
  'unified_exec',
  'js_repl',
  'code_mode',
  'apply_patch_freeform',
  'view_image',
  'web_search_request',
  'web_search_cached',
  'standalone_web_search',
  'apps',
  'plugins',
];

/** MCP server names Codex accepts as a config key (anything else is never passed on). */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Names of `[mcp_servers.<name>]` tables in a Codex `config.toml` (bare or quoted names; sub-tables such as
 * `[mcp_servers.<name>.env]` count once). Inline-table / dotted-key definitions are not recognized.
 */
export function codexMcpServerNames(toml: string): string[] {
  const out: string[] = [];
  const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"\\\n]*)"|'([^'\n]*)'|([A-Za-z0-9_-]+))/gm;
  for (const m of toml.matchAll(header)) {
    const name = m[1] ?? m[2] ?? m[3] ?? '';
    if (MCP_SERVER_NAME.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

export const codexLaunchEnv: CodexLaunchEnvFn = ({ model, effort, permissionMode, noTools }) => {
  if (model !== null && !CODEX_MODEL_PATTERN.test(model)) return { ok: false, error: 'invalid-model' };
  if (effort !== null && !CODEX_EFFORTS.has(effort)) return { ok: false, error: 'invalid-effort' };
  const config: Record<string, unknown> = {};
  if (model !== null) config.model = model;
  if (effort !== null) config.model_reasoning_effort = effort;
  if (noTools) {
    config.web_search = 'disabled';
    config.features = Object.fromEntries(NOTE_CODEX_FEATURES_OFF.map((k) => [k, false]));
    const servers = noTools.mcpServers.filter((n) => MCP_SERVER_NAME.test(n));
    if (servers.length > 0) config.mcp_servers = Object.fromEntries(servers.map((n) => [n, { enabled: false }]));
  }
  const mode = CODEX_MODE_BY_PERMISSION[permissionMode] ?? CODEX_MODE_BY_PERMISSION.default;
  return { ok: true, env: { CODEX_CONFIG: JSON.stringify(config), INITIAL_AGENT_MODE: mode } };
};

export const reconcileConfig: ReconcileConfigFn = (configOptions, wanted) => {
  const result: ReturnType<ReconcileConfigFn> = { set: [], missing: [] };
  const check = (category: 'model' | 'thought_level', value: string | null) => {
    if (value === null || value === '') return;
    const option = configOptions.find((o) => o.category === category && o.type === 'select');
    if (!option || option.type !== 'select' || option.currentValue === value) return;
    if (option.options.some((o) => o.value === value)) result.set.push({ configId: option.id, value });
    else result.missing.push({ category, wanted: value, current: option.currentValue });
  };
  check('model', wanted.model);
  check('thought_level', wanted.effort);
  return result;
};
