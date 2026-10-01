import { describe, expect, it } from 'vitest';
import { pickOption, pickSessionOption } from '../../src/core/acpPermission';
import type { AcpPermissionOptionLite } from '../../src/shared/types';

const opt = (optionId: string, name: string, kind: AcpPermissionOptionLite['kind']): AcpPermissionOptionLite => ({
  optionId,
  name,
  kind,
});

const CODEX = [
  opt('approved', 'Yes', 'allow_once'),
  opt('approved-always', 'Always allow', 'allow_always'),
  opt('abort', 'No', 'reject_once'),
];
const HERMES = [
  opt('allow_once', 'Allow once', 'allow_once'),
  opt('allow_always', 'Allow always', 'allow_always'),
  opt('allow_session', 'Allow for this session', 'allow_always'),
  opt('deny', 'Deny', 'reject_once'),
];

describe('pickOption', () => {
  it('allow picks the first allow_once', () => {
    expect(pickOption('allow', HERMES)).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    expect(pickOption('allow', [opt('a', 'A', 'allow_always')])).toBeNull();
  });

  it('allow-session prefers a session-scoped allow_always over a permanent one', () => {
    expect(pickOption('allow-session', HERMES)).toEqual({ outcome: 'selected', optionId: 'allow_session' });
    expect(pickSessionOption(HERMES)?.optionId).toBe('allow_session');
    // matched by name too
    const byName = [opt('x1', 'Always', 'allow_always'), opt('x2', 'This Session', 'allow_always')];
    expect(pickOption('allow-session', byName)).toEqual({ outcome: 'selected', optionId: 'x2' });
  });

  it('allow-session falls back to the first allow_always, else null', () => {
    expect(pickOption('allow-session', CODEX)).toEqual({ outcome: 'selected', optionId: 'approved-always' });
    expect(pickOption('allow-session', [opt('a', 'A', 'allow_once')])).toBeNull();
    expect(pickSessionOption([])).toBeNull();
  });

  it('deny picks reject_once and never reject_always', () => {
    expect(pickOption('deny', HERMES)).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(pickOption('deny', [opt('r', 'Never', 'reject_always')])).toEqual({ outcome: 'cancelled' });
    expect(pickOption('deny', [])).toEqual({ outcome: 'cancelled' });
  });
});
