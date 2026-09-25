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
