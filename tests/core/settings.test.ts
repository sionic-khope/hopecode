import { describe, expect, it } from 'vitest';
import { sanitizeSettings, validateSettingsPatch } from '../../src/core/settings';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

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
