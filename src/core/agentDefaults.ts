// Per-agent draft defaults, codex-acp launch arguments and post-open config reconciliation (plan 2.11 / 2.15). Pure.
import { CODEX_EFFORT_LEVELS, CODEX_MODEL_PATTERN } from '../shared/constants';
import type { AcpModeLite, UiPermissionMode } from '../shared/types';
import type { CodexLaunchArgsFn, DraftAgentDefaultsFn, ReconcileConfigFn } from './acpTypes';

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

/** App permission chip -> codex `approval_policy` / `sandbox_mode` (fixed table, no user text). */
const PERMISSION_TABLE: Readonly<Record<UiPermissionMode, { approval: string; sandbox: string }>> = {
  default: { approval: 'on-request', sandbox: 'workspace-write' },
  plan: { approval: 'on-request', sandbox: 'read-only' },
  acceptEdits: { approval: 'on-request', sandbox: 'workspace-write' },
  bypassPermissions: { approval: 'never', sandbox: 'danger-full-access' },
};

export const codexLaunchArgs: CodexLaunchArgsFn = ({ model, effort, permissionMode }) => {
  if (model !== null && !CODEX_MODEL_PATTERN.test(model)) return { ok: false, error: 'invalid-model' };
  if (effort !== null && !CODEX_EFFORTS.has(effort)) return { ok: false, error: 'invalid-effort' };
  const perm = PERMISSION_TABLE[permissionMode] ?? PERMISSION_TABLE.default;
  const args: string[] = [];
  if (model !== null) args.push('-c', `model="${model}"`);
  if (effort !== null) args.push('-c', `model_reasoning_effort="${effort}"`);
  args.push('-c', `approval_policy="${perm.approval}"`, '-c', `sandbox_mode="${perm.sandbox}"`);
  return { ok: true, args };
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
