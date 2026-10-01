import { describe, expect, it } from 'vitest';
import type { AgentUsageSnapshot, LocalAuthInfo } from '../../src/shared/types';
import { localAuthView } from '../../src/renderer/components/Accounts/localAuthView';
import { statusLineMode, usageSourceTitle, usageWindowsFor } from '../../src/renderer/components/StatusLine/statusLineMode';
import { isScratchThread } from '../../src/renderer/components/Changes/scratchGit';

const info = (over: Partial<LocalAuthInfo>): LocalAuthInfo => ({
  agent: 'codex',
  state: 'logged-in',
  method: 'chatgpt',
  email: 'a@b.co',
  plan: 'plus',
  provider: null,
  source: '~/.codex/auth.json',
  version: null,
  detail: null,
  checkedAt: 0,
  ...over,
});

describe('localAuthView', () => {
  it('maps states to labels', () => {
    expect(localAuthView(info({})).stateLabel).toBe('로그인됨');
    expect(localAuthView(info({ state: 'logged-out' })).stateLabel).toBe('미로그인');
    expect(localAuthView(info({ state: 'not-installed' })).stateLabel).toBe('미설치');
    expect(localAuthView(undefined).stateLabel).toBe('확인 중');
  });
  it('shows email, plan and source only', () => {
    const v = localAuthView(info({}));
    expect(v.identity).toBe('a@b.co · plus');
    expect(v.source).toBe('~/.codex/auth.json');
    expect(JSON.stringify(v)).not.toMatch(/token/i);
  });
  it('falls back to the hermes provider', () => {
    expect(localAuthView(info({ agent: 'hermes', email: null, plan: null, provider: 'og' })).identity).toBe('provider: og');
  });
});

describe('statusLineMode', () => {
  it('follows the agent', () => {
    expect(statusLineMode(null)).toBe('pool');
    expect(statusLineMode({ agent: 'claude-code' })).toBe('pool');
    expect(statusLineMode({ agent: 'codex' })).toBe('basic');
    expect(statusLineMode({ agent: 'hermes' })).toBe('agent-usage');
  });
  it('hides windows without a matching snapshot', () => {
    const snap: AgentUsageSnapshot = {
      agent: 'hermes',
      provider: 'og',
      title: null,
      plan: 'pro',
      windows: [{ label: '5h', usedPercent: 10, resetsAt: null, detail: null }],
      fetchedAt: 1,
    };
    expect(usageWindowsFor('hermes', null)).toEqual([]);
    expect(usageWindowsFor('codex', snap)).toEqual([]);
    expect(usageWindowsFor('hermes', snap)).toHaveLength(1);
    expect(usageSourceTitle(snap)).toContain('hermes usage');
  });
});

describe('isScratchThread', () => {
  it('is true only for null projectId', () => {
    expect(isScratchThread({ projectId: null })).toBe(true);
    expect(isScratchThread({ projectId: 'p1' })).toBe(false);
  });
});
