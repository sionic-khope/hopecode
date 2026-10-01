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

export const codexLaunchEnv: CodexLaunchEnvFn = ({ model, effort, permissionMode }) => {
  if (model !== null && !CODEX_MODEL_PATTERN.test(model)) return { ok: false, error: 'invalid-model' };
  if (effort !== null && !CODEX_EFFORTS.has(effort)) return { ok: false, error: 'invalid-effort' };
  const config: Record<string, string> = {};
  if (model !== null) config.model = model;
  if (effort !== null) config.model_reasoning_effort = effort;
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
