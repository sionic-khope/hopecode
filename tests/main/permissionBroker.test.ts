import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createRecordingBroadcaster } from '../../src/main/fixtures/memoryDeps';
import {
  createPermissionBroker,
  PERMISSION_CANCELLED_MESSAGE,
  PERMISSION_DENIED_MESSAGE,
  toSessionPermissions,
} from '../../src/main/session/permissionBroker';

const suggestions: PermissionUpdate[] = [
  { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'userSettings' },
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addDirectories', directories: ['/tmp/x'], destination: 'projectSettings' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];

function setup() {
  const broadcaster = createRecordingBroadcaster();
  const broker = createPermissionBroker({ broadcaster });
  const ask = (requestId: string, opts: { abort?: AbortController; suggestions?: PermissionUpdate[]; threadId?: string } = {}) => {
    const abort = opts.abort ?? new AbortController();
    const promise = broker.canUseToolFor(opts.threadId ?? 't1')(
      'Edit',
      { file_path: 'a.ts' },
      {
        signal: abort.signal,
        suggestions: opts.suggestions,
        toolUseID: `toolu-${requestId}`,
        requestId,
        title: 'Claude wants to edit a.ts',
        displayName: 'Edit file',
        defaultToNo: true,
      },
    ) as Promise<PermissionResult>;
    return { promise, abort };
  };
  return { broadcaster, broker, ask };
}

describe('permissionBroker', () => {
  it('keys requests by options.requestId and broadcasts permission:request', async () => {
    const { broker, broadcaster, ask } = setup();
    const { promise } = ask('req-1', { suggestions });

    const [request] = broadcaster.of('permission:request');
    expect(request).toMatchObject({
      requestId: 'req-1',
      threadId: 't1',
      toolUseId: 'toolu-req-1',
      toolName: 'Edit',
      input: { file_path: 'a.ts' },
      title: 'Claude wants to edit a.ts',
      displayName: 'Edit file',
      hasSessionSuggestion: true,
      defaultToNo: true,
    });
    expect(broker.pending().map((r) => r.requestId)).toEqual(['req-1']);

    // Responding with the toolUseID must not resolve the request.
    broker.respond('toolu-req-1', 'allow');
    expect(broker.pending()).toHaveLength(1);

    broker.respond('req-1', 'allow');
    await expect(promise).resolves.toEqual({ behavior: 'allow', updatedInput: { file_path: 'a.ts' } });
    expect(broker.pending()).toHaveLength(0);
  });

  it('allow-session forces every updatedPermissions destination to session', async () => {
    const { broker, ask } = setup();
    const { promise } = ask('req-2', { suggestions });
    broker.respond('req-2', 'allow-session');
    const result = await promise;
    expect(result.behavior).toBe('allow');
    if (result.behavior !== 'allow') throw new Error('unreachable');
    expect(result.updatedPermissions).toHaveLength(suggestions.length);
    expect(result.updatedPermissions!.every((p) => p.destination === 'session')).toBe(true);
    // Rule content is preserved; only the destination changes.
    expect(result.updatedPermissions![1]).toMatchObject({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] });
    // Original suggestions untouched.
    expect(suggestions[0]!.destination).toBe('userSettings');
  });

  it('(L8) drops setMode->bypassPermissions suggestions and reports an accepted setMode to the store hook', async () => {
    expect(
      toSessionPermissions([
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
      ]),
    ).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);

    const broadcaster = createRecordingBroadcaster();
    const changes: [string, string][] = [];
    const broker = createPermissionBroker({ broadcaster, onModeChange: (t, m) => changes.push([t, m]) });
    const only = broker.canUseToolFor('t9')('Edit', {}, {
      signal: new AbortController().signal,
      suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
      toolUseID: 'tu',
      requestId: 'r-bypass',
    });
    // Nothing left to allow for the session.
    expect(broadcaster.of('permission:request')[0]!.hasSessionSuggestion).toBe(false);
    broker.respond('r-bypass', 'allow-session');
    await only;
    expect(changes).toEqual([]);

    const p = broker.canUseToolFor('t9')('Edit', {}, {
      signal: new AbortController().signal,
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      toolUseID: 'tu2',
      requestId: 'r-accept',
    });
    broker.respond('r-accept', 'allow-session');
    await p;
    expect(changes).toEqual([['t9', 'acceptEdits']]);
  });

  it('toSessionPermissions handles missing suggestions', () => {
    expect(toSessionPermissions(undefined)).toEqual([]);
  });

  it('deny resolves with a message (never null)', async () => {
    const { broker, ask } = setup();
    const a = ask('req-3');
    broker.respond('req-3', 'deny');
    await expect(a.promise).resolves.toEqual({ behavior: 'deny', message: PERMISSION_DENIED_MESSAGE });

    const b = ask('req-4');
    broker.respond('req-4', 'deny', 'use a different file');
    await expect(b.promise).resolves.toEqual({ behavior: 'deny', message: 'use a different file' });
  });

  it('abort signal -> permission:cancel + deny', async () => {
    const { broker, broadcaster, ask } = setup();
    const { promise, abort } = ask('req-5');
    abort.abort();
    await expect(promise).resolves.toEqual({ behavior: 'deny', message: PERMISSION_CANCELLED_MESSAGE });
    expect(broadcaster.of('permission:cancel')).toEqual([{ requestId: 'req-5' }]);
    expect(broker.pending()).toHaveLength(0);
    // Late response is ignored.
    broker.respond('req-5', 'allow');
  });

  it('already-aborted signal denies immediately without broadcasting', async () => {
    const { broadcaster, ask } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(ask('req-6', { abort }).promise).resolves.toMatchObject({ behavior: 'deny' });
    expect(broadcaster.of('permission:request')).toHaveLength(0);
  });

  it('cancelThread / cancelAll deny pending requests and broadcast cancel', async () => {
    const { broker, broadcaster, ask } = setup();
    const a = ask('req-a', { threadId: 't1' });
    const b = ask('req-b', { threadId: 't2' });
    broker.cancelThread('t1');
    await expect(a.promise).resolves.toMatchObject({ behavior: 'deny' });
    expect(broker.pending().map((r) => r.requestId)).toEqual(['req-b']);
    broker.cancelAll();
    await expect(b.promise).resolves.toMatchObject({ behavior: 'deny' });
    expect(broadcaster.of('permission:cancel')).toEqual([{ requestId: 'req-a' }, { requestId: 'req-b' }]);
  });

  it('hasSessionSuggestion is false without suggestions', () => {
    const { broadcaster, ask } = setup();
    void ask('req-7');
    expect(broadcaster.of('permission:request')[0]!.hasSessionSuggestion).toBe(false);
  });
});

describe('permissionBroker.requestAcp (ACP session/request_permission)', () => {
  const hermesOptions = [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' as const },
    { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' as const },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
    { optionId: 'deny_always', name: 'Deny always', kind: 'reject_always' as const },
  ];
  const req = (options = hermesOptions) => ({
    sessionId: 's1',
    toolCall: { toolCallId: 'call-1', title: 'Run npm test', kind: 'execute' as const, rawInput: { command: 'npm test' } },
    options,
  });

  function acpSetup() {
    const broadcaster = createRecordingBroadcaster();
    const broker = createPermissionBroker({ broadcaster });
    return { broadcaster, broker };
  }

  it('broadcasts a card with the agent options and resolves with the mapped option', async () => {
    const { broker, broadcaster } = acpSetup();
    const p = broker.requestAcp('t1', 'hermes', req(), new AbortController().signal);
    const [card] = broadcaster.of('permission:request');
    expect(card).toMatchObject({
      threadId: 't1',
      toolUseId: 'call-1',
      toolName: 'Bash',
      input: { title: 'Run npm test', command: 'npm test' },
      title: 'Run npm test',
      agent: 'hermes',
      hasSessionSuggestion: true,
      sessionLabel: 'Allow for session',
    });
    expect(card!.requestId).toMatch(/^acp-/);
    expect(card!.agentOptions).toEqual(hermesOptions);
    broker.respond(card!.requestId, 'allow-session');
    await expect(p).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_session' } });
  });

  it('allow -> allow_once, deny -> reject_once; deny without reject_once -> cancelled (never reject_always)', async () => {
    const { broker, broadcaster } = acpSetup();
    const a = broker.requestAcp('t1', 'hermes', req(), new AbortController().signal);
    broker.respond(broadcaster.of('permission:request')[0]!.requestId, 'allow');
    await expect(a).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

    const d = broker.requestAcp('t1', 'hermes', req(), new AbortController().signal);
    broker.respond(broadcaster.of('permission:request')[1]!.requestId, 'deny');
    await expect(d).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });

    const onlyAlways = hermesOptions.filter((o) => o.kind !== 'reject_once');
    const c = broker.requestAcp('t1', 'hermes', req(onlyAlways), new AbortController().signal);
    broker.respond(broadcaster.of('permission:request')[2]!.requestId, 'deny');
    await expect(c).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('abort signal / cancelThread / cancelAll answer cancelled and broadcast permission:cancel', async () => {
    const { broker, broadcaster } = acpSetup();
    const abort = new AbortController();
    const a = broker.requestAcp('t1', 'codex', req(), abort.signal);
    const b = broker.requestAcp('t1', 'codex', req(), new AbortController().signal);
    const c = broker.requestAcp('t2', 'codex', req(), new AbortController().signal);
    abort.abort();
    await expect(a).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    broker.cancelThread('t1');
    await expect(b).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    broker.cancelAll();
    await expect(c).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(broadcaster.of('permission:cancel')).toHaveLength(3);
    expect(broker.pending()).toEqual([]);
  });

  it('already-aborted signal answers cancelled without a card; large rawInput becomes a truncated preview', async () => {
    const { broker, broadcaster } = acpSetup();
    const abort = new AbortController();
    abort.abort();
    await expect(broker.requestAcp('t1', 'codex', req(), abort.signal)).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(broadcaster.of('permission:request')).toHaveLength(0);

    const big = { ...req(), toolCall: { ...req().toolCall, rawInput: { blob: 'x'.repeat(20_000) } } };
    void broker.requestAcp('t1', 'codex', big, new AbortController().signal);
    const input = broadcaster.of('permission:request')[0]!.input;
    expect(input).toMatchObject({ title: 'Run npm test', truncated: true });
    const preview = String(input.preview);
    expect(preview.startsWith(`{"blob":"${'x'.repeat(6 * 1024 - 9)}\n… (truncated) …\n`)).toBe(true);
    expect(preview.endsWith(`${'x'.repeat(2 * 1024 - 2)}"}`)).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(8 * 1024 + 30);

    const spoof = { ...req(), toolCall: { ...req().toolCall, rawInput: { command: 'rm -rf x', title: 'harmless' } } };
    void broker.requestAcp('t1', 'codex', spoof, new AbortController().signal);
    expect(broadcaster.of('permission:request')[1]!.input).toEqual({ command: 'rm -rf x', title: 'Run npm test' });
    expect(broker.pending()).toHaveLength(2);
  });
});
