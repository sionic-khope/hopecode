// Pure renderer helpers behind the agent picker, the ACP composer chips, the 채팅 sidebar section and the ACP
// PermissionCard buttons (plan 5 Wave 2 G1).
import { describe, expect, it } from 'vitest';
import type { AcpControls, LocalAuthInfo, Thread } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import { draftAgentDefaults } from '../../src/core/agentDefaults';
import { agentAvailability, agentMenuState } from '../../src/renderer/components/Chat/agentMenuState';
import {
  agentModeChip,
  codexEffortChoices,
  codexModelChoices,
  codexThreadChip,
  EFFORT_LABEL,
  hermesModelLabel,
} from '../../src/renderer/components/Chat/acpChips';
import { chatSectionThreads } from '../../src/renderer/components/Sidebar/chatSection';
import { DENY_CANCELS_TURN, MAY_PERSIST, permissionButtons } from '../../src/renderer/components/Chat/permissionButtons';

function auth(agent: LocalAuthInfo['agent'], state: LocalAuthInfo['state']): LocalAuthInfo {
  return { agent, state, method: null, email: null, plan: null, provider: null, source: '', version: null, detail: null, checkedAt: 1 };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't',
    projectId: null,
    agent: 'codex',
    title: 't',
    cwd: '/scratch/t',
    model: 'gpt-6-sol',
    resolvedModel: null,
    permissionMode: 'default',
    effort: 'high',
    pinnedAccountId: null,
    pinned: false,
    archived: false,
    lastAccountId: null,
    activeAccountId: null,
    sdkSessionId: null,
    status: 'idle',
    waitingUntil: null,
    pendingPrompt: null,
    sessionStartedAt: null,
    ctxPercent: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const CODEX_CONTROLS: AcpControls = {
  modes: [],
  currentModeId: null,
  reportedModel: null,
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-6-sol',
      options: [
        { value: 'gpt-6-sol', name: 'GPT-6-Sol' },
        { value: 'gpt-6-mini', name: 'GPT-6 mini' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'ultra', name: 'Ultra' },
      ],
    },
  ],
};

describe('agentMenuState', () => {
  it('lists the three agents; Claude Code is always usable (account pool)', () => {
    const rows = agentMenuState([]);
    expect(rows.map((r) => r.name)).toEqual(['Claude Code', 'Codex', 'Hermes']);
    expect(rows[0].disabled).toBe(false);
  });

  it('disables agents that are not installed / not logged in, with the reason', () => {
    const rows = agentMenuState([auth('claude-code', 'logged-out'), auth('codex', 'logged-out'), auth('hermes', 'not-installed')]);
    expect(rows[0].disabled).toBe(false);
    expect(rows[1]).toMatchObject({ disabled: true, reason: 'not-logged-in' });
    expect(rows[1].description).toContain('로그인 필요');
    expect(rows[2]).toMatchObject({ disabled: true, reason: 'not-installed' });
    expect(rows[2].description).toContain('설치되지 않음');
  });

  it('enables logged-in agents; an undetected one waits (disabled, checking)', () => {
    const rows = agentMenuState([auth('codex', 'logged-in')]);
    expect(rows[1]).toMatchObject({ disabled: false, reason: 'ok' });
    expect(rows[2]).toMatchObject({ disabled: true, reason: 'checking' });
    expect(agentAvailability('hermes', [auth('hermes', 'error')])).toEqual({ agent: 'hermes', usable: false, reason: 'error' });
  });
});

describe('draft defaults per agent (chips)', () => {
  it('Claude Opus 5.5 · High, Codex GPT-6-Sol · High, Hermes system default', () => {
    expect(draftAgentDefaults('claude-code', DEFAULT_SETTINGS)).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    const codex = draftAgentDefaults('codex', DEFAULT_SETTINGS);
    expect(codex).toEqual({ model: 'gpt-6-sol', effort: 'high' });
    const label = codexModelChoices([], codex.model).find((c) => c.value === codex.model)?.label;
    expect(`${label} · ${EFFORT_LABEL[codex.effort as 'high']}`).toBe('GPT-6-Sol · High');
    expect(draftAgentDefaults('hermes', DEFAULT_SETTINGS)).toEqual({ model: '', effort: null });
    expect(hermesModelLabel(null)).toBe('시스템 기본값');
  });
});

describe('codex chips', () => {
  it('effort choices: the session-reported thought_level list first, else Codex\'s own set (with ultra, not Claude\'s)', () => {
    expect(codexEffortChoices([]).map((c) => c.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(codexEffortChoices([]).at(-1)).toEqual({ value: 'ultra', label: 'Ultra' });
    const reported = thread({ acp: { sessionId: 's', controls: CODEX_CONTROLS }, updatedAt: 5 });
    expect(codexEffortChoices([reported]).map((c) => c.value)).toEqual(['medium', 'high', 'ultra']);
  });

  it('model choices come from the newest reported config option, else the built-in table', () => {
    expect(codexModelChoices([], 'gpt-6-sol')).toEqual([{ value: 'gpt-6-sol', label: 'GPT-6-Sol' }]);
    expect(codexModelChoices([], 'custom-x').map((c) => c.value)).toEqual(['custom-x', 'gpt-6-sol']);
    const reported = thread({ acp: { sessionId: 's', controls: CODEX_CONTROLS }, updatedAt: 5 });
    const older = thread({ id: 'o', acp: { sessionId: 's', controls: { ...CODEX_CONTROLS, configOptions: [] } }, updatedAt: 9 });
    expect(codexModelChoices([older, reported], 'gpt-6-sol').map((c) => c.label)).toEqual(['GPT-6-Sol', 'GPT-6 mini']);
  });

  it('thread chip: session values and config ids when reported, read-only stored values before', () => {
    const live = codexThreadChip(thread({ acp: { sessionId: 's', controls: CODEX_CONTROLS } }));
    expect(live).toMatchObject({ modelLabel: 'GPT-6-Sol', effortLabel: 'High', modelConfigId: 'model', effortConfigId: 'reasoning_effort' });
    expect(live.efforts.map((e) => e.label)).toEqual(['Medium', 'High', 'Ultra']);
    const before = codexThreadChip(thread({ acp: undefined }));
    expect(before).toMatchObject({ modelLabel: 'GPT-6-Sol', effortLabel: 'High', modelConfigId: null, effortConfigId: null, models: [] });
  });
});

describe('hermes chips', () => {
  it('model label is read-only system default with the reported model', () => {
    expect(hermesModelLabel('og/deepseek-fixture')).toBe('시스템 기본값 · og/deepseek-fixture');
    expect(hermesModelLabel('  ')).toBe('시스템 기본값');
  });

  it('mode chip follows the session modes; a pending choice wins', () => {
    const controls: AcpControls = {
      modes: [
        { id: 'default', name: 'Default' },
        { id: 'yolo', name: 'YOLO', description: 'no prompts' },
      ],
      currentModeId: 'default',
      configOptions: [],
      reportedModel: null,
    };
    expect(agentModeChip(undefined)).toBeNull();
    expect(agentModeChip({ sessionId: 's', controls: { ...controls, modes: [] } })).toBeNull();
    expect(agentModeChip({ sessionId: 's', controls })).toMatchObject({ label: 'Default', currentModeId: 'default' });
    expect(agentModeChip({ sessionId: null, controls, pendingModeId: 'yolo' })?.label).toBe('YOLO');
  });
});

describe('chatSectionThreads', () => {
  it('keeps unpinned, unarchived chats without a project, newest first', () => {
    const rows = chatSectionThreads([
      thread({ id: 'a', updatedAt: 1 }),
      thread({ id: 'b', updatedAt: 3 }),
      thread({ id: 'p', updatedAt: 9, pinned: true }),
      thread({ id: 'x', updatedAt: 9, archived: true }),
      thread({ id: 'proj', updatedAt: 9, projectId: 'p1' }),
    ]);
    expect(rows.map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('permissionButtons', () => {
  it('Claude requests keep the plain buttons', () => {
    expect(permissionButtons({ hasSessionSuggestion: true })).toEqual({
      allow: { enabled: true },
      allowSession: { shown: true, caption: null, warn: false },
      deny: { caption: null },
      agentOptionNames: [],
    });
  });

  it('ACP: no reject_once → deny may cancel the whole turn; session caption is the agent name', () => {
    const b = permissionButtons({
      hasSessionSuggestion: true,
      sessionLabel: 'Allow for session',
      agentOptions: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
        { optionId: 'never', name: 'Reject always', kind: 'reject_always' },
      ],
    });
    expect(b.allow.enabled).toBe(true);
    expect(b.allowSession).toEqual({ shown: true, caption: 'Allow for session', warn: false });
    expect(b.deny.caption).toBe(DENY_CANCELS_TURN);
    expect(b.agentOptionNames).toEqual(['Allow once', 'Allow for session', 'Reject always']);
  });

  it('ACP: reject_once present → no caveat; no allow_once → allow disabled; "always" warns', () => {
    const b = permissionButtons({
      hasSessionSuggestion: true,
      sessionLabel: 'Always allow',
      agentOptions: [
        { optionId: 'a', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'r', name: 'Reject', kind: 'reject_once' },
      ],
    });
    expect(b.allow.enabled).toBe(false);
    expect(b.deny.caption).toBeNull();
    expect(b.allowSession.warn).toBe(true);
    expect(b.allowSession.caption).toBe(`Always allow · ${MAY_PERSIST}`);
  });
});
