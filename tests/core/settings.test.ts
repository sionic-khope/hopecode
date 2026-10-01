import { describe, expect, it } from 'vitest';
import { sanitizeSettings, validateSettingsPatch } from '../../src/core/settings';
import { DEFAULT_NEW_TASK_TEMPLATE, DEFAULT_SETTINGS, NEW_TASK_TEMPLATE_MAX_CHARS, SETTINGS_REV } from '../../src/shared/constants';

describe('settings validation', () => {
  it('accepts every documented field within range', () => {
    const res = validateSettingsPatch({
      idleCloseMinutes: 0,
      defaultModel: 'opus',
      defaultPermissionMode: 'acceptEdits',
      defaultEffort: null,
      useWorktree: false,
      autoSwitchAccounts: false,
      usagePollIntervalSec: 60,
      notifications: true,
      defaultEditor: null,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects out-of-range numbers, bypass as a default and unknown keys', () => {
    expect(validateSettingsPatch({ usagePollIntervalSec: 59 }).ok).toBe(false);
    expect(validateSettingsPatch({ usagePollIntervalSec: 90.5 }).ok).toBe(false);
    expect(validateSettingsPatch({ idleCloseMinutes: -1 }).ok).toBe(false);
    expect(validateSettingsPatch({ defaultPermissionMode: 'bypassPermissions' }).ok).toBe(false);
    expect(validateSettingsPatch({ defaultModel: 'has space' }).ok).toBe(false);
    expect(validateSettingsPatch({ tosNoticeAcknowledged: true }).ok).toBe(false);
    expect(validateSettingsPatch({ other: 1 }).ok).toBe(false);
  });

  it('newTaskTemplate: keeps valid text, blank falls back to the default, over-length is rejected', () => {
    expect(validateSettingsPatch({ newTaskTemplate: 'custom template text' })).toEqual({
      ok: true,
      patch: { newTaskTemplate: 'custom template text' },
    });
    expect(validateSettingsPatch({ newTaskTemplate: '   ' })).toEqual({
      ok: true,
      patch: { newTaskTemplate: DEFAULT_NEW_TASK_TEMPLATE },
    });
    expect(validateSettingsPatch({ newTaskTemplate: '' })).toEqual({
      ok: true,
      patch: { newTaskTemplate: DEFAULT_NEW_TASK_TEMPLATE },
    });
    expect(validateSettingsPatch({ newTaskTemplate: 'x'.repeat(NEW_TASK_TEMPLATE_MAX_CHARS) }).ok).toBe(true);
    expect(validateSettingsPatch({ newTaskTemplate: 'x'.repeat(NEW_TASK_TEMPLATE_MAX_CHARS + 1) }).ok).toBe(false);
    expect(validateSettingsPatch({ newTaskTemplate: 42 }).ok).toBe(false);
  });

  it('sanitizes what state.json holds: defaults for missing / invalid fields, old files keep working', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    // A settings object from before the settings screen existed.
    // (Before effort existed a missing defaultEffort meant the model's default: kept as null.)
    expect(sanitizeSettings({ idleCloseMinutes: 5, defaultModel: 'sonnet', defaultPermissionMode: 'plan', tosNoticeAcknowledged: true })).toEqual({
      ...DEFAULT_SETTINGS,
      idleCloseMinutes: 5,
      defaultModel: 'sonnet',
      defaultEffort: null,
      defaultPermissionMode: 'plan',
      tosNoticeAcknowledged: true,
    });
    expect(
      sanitizeSettings({ usagePollIntervalSec: 9999, useWorktree: 'yes', defaultPermissionMode: 'bypassPermissions', idleCloseMinutes: 7.6 }),
    ).toEqual({ ...DEFAULT_SETTINGS, idleCloseMinutes: 8 });
  });

  it('defaults: Claude Opus 5.5 / high, Codex gpt-6.1-sol / high, local Claude in the pool, current revision', () => {
    expect(DEFAULT_SETTINGS.defaultModel).toBe('claude-opus-5-5');
    expect(DEFAULT_SETTINGS.defaultEffort).toBe('high');
    expect(DEFAULT_SETTINGS.codexDefaultModel).toBe('gpt-6.1-sol');
    expect(DEFAULT_SETTINGS.codexDefaultEffort).toBe('high');
    expect(DEFAULT_SETTINGS.localClaudeInPool).toBe(true);
    expect(DEFAULT_SETTINGS.settingsRev).toBe(SETTINGS_REV);
    expect(SETTINGS_REV).toBe(3);
  });

  it('rev < 2: untouched old defaults (default / null) become the new defaults', () => {
    const out = sanitizeSettings({ defaultModel: 'default', defaultEffort: null, settingsRev: 1 });
    expect(out.defaultModel).toBe('claude-opus-5-5');
    expect(out.defaultEffort).toBe('high');
    expect(out.settingsRev).toBe(3);
    // No revision at all (every file written before rev 2) is treated the same.
    expect(sanitizeSettings({ defaultModel: 'default', defaultEffort: null })).toMatchObject({
      defaultModel: 'claude-opus-5-5',
      defaultEffort: 'high',
      settingsRev: 3,
    });
    expect(sanitizeSettings({ defaultModel: 'default' })).toMatchObject({ defaultModel: 'claude-opus-5-5', defaultEffort: 'high' });
  });

  it('rev < 2: values the user picked are kept', () => {
    expect(sanitizeSettings({ defaultModel: 'sonnet', defaultEffort: null })).toMatchObject({ defaultModel: 'sonnet', defaultEffort: null });
    expect(sanitizeSettings({ defaultModel: 'default', defaultEffort: 'low' })).toMatchObject({ defaultModel: 'default', defaultEffort: 'low' });
    expect(sanitizeSettings({ defaultModel: 'opus', defaultEffort: 'max' })).toMatchObject({ defaultModel: 'opus', defaultEffort: 'max' });
  });

  it('rev 2: default / null saved on purpose is not migrated again', () => {
    expect(sanitizeSettings({ defaultModel: 'default', defaultEffort: null, settingsRev: 2 })).toMatchObject({
      defaultModel: 'default',
      defaultEffort: null,
      settingsRev: 3,
    });
  });

  it('rev < 3: only the untouched old Codex default (gpt-6-sol) moves to gpt-6.1-sol', () => {
    expect(sanitizeSettings({ codexDefaultModel: 'gpt-6-sol', settingsRev: 2 })).toMatchObject({ codexDefaultModel: 'gpt-6.1-sol', settingsRev: 3 });
    expect(sanitizeSettings({ codexDefaultModel: 'gpt-6-sol' }).codexDefaultModel).toBe('gpt-6.1-sol');
    // Another model the user picked is kept, and so is gpt-6-sol picked again after the migration (rev 3).
    expect(sanitizeSettings({ codexDefaultModel: 'gpt-6-mini', settingsRev: 2 }).codexDefaultModel).toBe('gpt-6-mini');
    expect(sanitizeSettings({ codexDefaultModel: 'gpt-6-sol', settingsRev: 3 }).codexDefaultModel).toBe('gpt-6-sol');
  });

  it('codex defaults: model id pattern (no TOML injection) and effort level', () => {
    expect(validateSettingsPatch({ codexDefaultModel: 'gpt-6-sol', codexDefaultEffort: 'xhigh' })).toEqual({
      ok: true,
      patch: { codexDefaultModel: 'gpt-6-sol', codexDefaultEffort: 'xhigh' },
    });
    for (const bad of ['gpt"6', 'a b', 'x=y', 'line\nbreak', '', '-lead', 'x'.repeat(65), 42, null]) {
      expect(validateSettingsPatch({ codexDefaultModel: bad }).ok).toBe(false);
    }
    expect(validateSettingsPatch({ codexDefaultEffort: null }).ok).toBe(false);
    // Codex has its own set (models_cache supported_reasoning_levels): `ultra` is valid, unknown values are not.
    expect(validateSettingsPatch({ codexDefaultEffort: 'ultra' })).toEqual({ ok: true, patch: { codexDefaultEffort: 'ultra' } });
    expect(validateSettingsPatch({ codexDefaultEffort: 'minimal' }).ok).toBe(false);
    // Invalid stored values fall back to the defaults.
    expect(sanitizeSettings({ codexDefaultModel: 'bad"model', codexDefaultEffort: 'nope' })).toMatchObject({
      codexDefaultModel: 'gpt-6.1-sol',
      codexDefaultEffort: 'high',
    });
  });

  it('settingsRev and localClaudeInPool cannot be set through settings:update, but load from disk', () => {
    expect(validateSettingsPatch({ settingsRev: 3 }).ok).toBe(false);
    expect(validateSettingsPatch({ localClaudeInPool: false }).ok).toBe(false);
    expect(sanitizeSettings({ localClaudeInPool: false }).localClaudeInPool).toBe(false);
    expect(sanitizeSettings({ localClaudeInPool: 'no' }).localClaudeInPool).toBe(true);
    expect(sanitizeSettings({ settingsRev: 99 }).settingsRev).toBe(SETTINGS_REV);
  });
});
