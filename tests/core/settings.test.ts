import { describe, expect, it } from 'vitest';
import { sanitizeSettings, validateSettingsPatch } from '../../src/core/settings';
import { DEFAULT_NEW_TASK_TEMPLATE, DEFAULT_SETTINGS, NEW_TASK_TEMPLATE_MAX_CHARS } from '../../src/shared/constants';

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
    expect(sanitizeSettings({ idleCloseMinutes: 5, defaultModel: 'sonnet', defaultPermissionMode: 'plan', tosNoticeAcknowledged: true })).toEqual({
      ...DEFAULT_SETTINGS,
      idleCloseMinutes: 5,
      defaultModel: 'sonnet',
      defaultPermissionMode: 'plan',
      tosNoticeAcknowledged: true,
    });
    expect(
      sanitizeSettings({ usagePollIntervalSec: 9999, useWorktree: 'yes', defaultPermissionMode: 'bypassPermissions', idleCloseMinutes: 7.6 }),
    ).toEqual({ ...DEFAULT_SETTINGS, idleCloseMinutes: 8 });
  });
});
