// AppSettings validation shared by the store migration (whatever state.json holds) and `settings:update`
// (renderer input). Pure: no fs, no Electron.
import {
  DEFAULT_NEW_TASK_TEMPLATE,
  DEFAULT_SETTINGS,
  EFFORT_LEVELS,
  IDLE_CLOSE_MAX_MINUTES,
  NEW_TASK_TEMPLATE_MAX_CHARS,
  UI_PERMISSION_MODES,
  USAGE_POLL_MAX_SEC,
  USAGE_POLL_MIN_SEC,
} from '../shared/constants';
import type { AppSettings, EditorId, EffortLevel, SettingsPatch, UiPermissionMode } from '../shared/types';

export const EDITOR_IDS: readonly EditorId[] = ['vscode', 'cursor', 'zed', 'xcode', 'finder', 'terminal', 'iterm', 'ghostty'];

const MODEL_VALUE_MAX = 200;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** A new chat may start in any mode except bypassPermissions (that one is confirmed per thread). */
function isDefaultMode(v: unknown): v is UiPermissionMode {
  return typeof v === 'string' && v !== 'bypassPermissions' && (UI_PERMISSION_MODES as readonly string[]).includes(v);
}

function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

function isModelValue(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MODEL_VALUE_MAX && !/[\s\0]/.test(v);
}

export function isEditorId(v: unknown): v is EditorId {
  return typeof v === 'string' && (EDITOR_IDS as readonly string[]).includes(v);
}

export type SettingsPatchResult = { ok: true; patch: SettingsPatch } | { ok: false; error: string };

/**
 * Validates a renderer patch field by field. Unknown keys and `tosNoticeAcknowledged` are rejected (not ignored), so
 * a typo never looks like a saved setting.
 */
export function validateSettingsPatch(raw: unknown): SettingsPatchResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'settings patch must be an object' };
  const input = raw as Record<string, unknown>;
  const patch: SettingsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'idleCloseMinutes':
        if (!isInt(value) || value < 0 || value > IDLE_CLOSE_MAX_MINUTES) return { ok: false, error: `idleCloseMinutes must be 0..${IDLE_CLOSE_MAX_MINUTES}` };
        patch.idleCloseMinutes = value;
        break;
      case 'defaultModel':
        if (!isModelValue(value)) return { ok: false, error: 'defaultModel must be a model value' };
        patch.defaultModel = value;
        break;
      case 'defaultPermissionMode':
        if (!isDefaultMode(value)) return { ok: false, error: 'defaultPermissionMode must be default, plan or acceptEdits' };
        patch.defaultPermissionMode = value;
        break;
      case 'defaultEffort':
        if (value !== null && !isEffort(value)) return { ok: false, error: 'defaultEffort must be an effort level or null' };
        patch.defaultEffort = value;
        break;
      case 'useWorktree':
      case 'autoSwitchAccounts':
      case 'notifications':
        if (typeof value !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
        patch[key] = value;
        break;
      case 'usagePollIntervalSec':
        if (!isInt(value) || value < USAGE_POLL_MIN_SEC || value > USAGE_POLL_MAX_SEC) {
          return { ok: false, error: `usagePollIntervalSec must be ${USAGE_POLL_MIN_SEC}..${USAGE_POLL_MAX_SEC}` };
        }
        patch.usagePollIntervalSec = value;
        break;
      case 'defaultEditor':
        if (value !== null && !isEditorId(value)) return { ok: false, error: 'defaultEditor must be an editor id or null' };
        patch.defaultEditor = value;
        break;
      case 'newTaskTemplate':
        if (typeof value !== 'string') return { ok: false, error: 'newTaskTemplate must be a string' };
        if (value.length > NEW_TASK_TEMPLATE_MAX_CHARS) {
          return { ok: false, error: `newTaskTemplate must be at most ${NEW_TASK_TEMPLATE_MAX_CHARS} characters` };
        }
        // Blank is not a valid template: it silently falls back to the default instead of being rejected.
        patch.newTaskTemplate = value.trim().length === 0 ? DEFAULT_NEW_TASK_TEMPLATE : value;
        break;
      default:
        return { ok: false, error: `unknown setting: ${key}` };
    }
  }
  return { ok: true, patch };
}

/** Settings loaded from disk: every invalid or missing field falls back to its default (never throws). */
export function sanitizeSettings(raw: unknown): AppSettings {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    if (!(key in input)) continue;
    if (key === 'tosNoticeAcknowledged') {
      out.tosNoticeAcknowledged = input.tosNoticeAcknowledged === true;
      continue;
    }
    const checked = validateSettingsPatch({ [key]: input[key] });
    if (checked.ok) Object.assign(out, checked.patch);
  }
  // Older builds could store a bypass default; a new chat never starts in it.
  if (input.defaultPermissionMode === 'bypassPermissions') out.defaultPermissionMode = 'default';
  // idleCloseMinutes saved as a non-integer (older builds did not validate): round into range.
  if (typeof input.idleCloseMinutes === 'number' && Number.isFinite(input.idleCloseMinutes) && !isInt(input.idleCloseMinutes)) {
    out.idleCloseMinutes = Math.min(IDLE_CLOSE_MAX_MINUTES, Math.max(0, Math.round(input.idleCloseMinutes)));
  }
  return out;
}

export function applySettingsPatch(settings: AppSettings, patch: SettingsPatch): AppSettings {
  return { ...settings, ...patch };
}
