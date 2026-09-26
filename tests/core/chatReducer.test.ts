import { describe, expect, it } from 'vitest';
import { createChatReducerState, reduceSdkMessage, type SdkMessageLike } from '../../src/core/chatReducer';
import type { ChatReducerState } from '../../src/shared/types';

const NOW = 1_000_000_000_000;

function msg(partial: Record<string, unknown>): SdkMessageLike {
  return partial as unknown as SdkMessageLike;
}

function textDelta(text: string) {
  return msg({
    type: 'stream_event',
    session_id: 'sess-1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  });
}

function assistantText(text: string, error?: string) {
  return msg({
    type: 'assistant',
    session_id: 'sess-1',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...(error ? { error } : {}),
  });
}

function assistantToolUse(id: string, name: string, input: Record<string, unknown>) {
  return msg({
    type: 'assistant',
    session_id: 'sess-1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}

function userToolResult(toolUseId: string, content: string, opts?: { isError?: boolean; toolUseResult?: unknown }) {
  return msg({
    type: 'user',
    session_id: 'sess-1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: opts?.isError }],
    },
    tool_use_result: opts?.toolUseResult,
  });
}

describe('reduceSdkMessage', () => {
  it('accumulates text_delta chunks under a single itemId', () => {
    let state = createChatReducerState('t1');
    const r1 = reduceSdkMessage(state, textDelta('Hel'), NOW);
    state = r1.state;
    const r2 = reduceSdkMessage(state, textDelta('lo'), NOW);
    state = r2.state;

    expect(r1.events).toEqual([{ type: 'text-delta', itemId: (r1.events[0] as any).itemId, text: 'Hel' }]);
    expect(r2.events).toEqual([{ type: 'text-delta', itemId: (r1.events[0] as any).itemId, text: 'lo' }]);
    expect(state.streamingText).toBe('Hello');
  });

  it('finalizes an assistant-text item on the completed assistant message', () => {
    let state = createChatReducerState('t1');
    const delta = reduceSdkMessage(state, textDelta('Hi'), NOW);
    state = delta.state;
    const itemId = (delta.events[0] as any).itemId;

    const final = reduceSdkMessage(state, assistantText('Hi'), NOW);
    expect(final.events).toContainEqual({
      type: 'item-upsert',
      item: { type: 'assistant-text', id: itemId, text: 'Hi', createdAt: NOW },
    });
    expect(final.state.streamingItemId).toBeNull();
  });

  it('turns a tool_use block into a ToolItem item-upsert', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(state, assistantToolUse('tu-1', 'Read', { file_path: '/a.ts' }), NOW);

    expect(result.events).toContainEqual({
      type: 'item-upsert',
      item: {
        type: 'tool',
        id: expect.any(String),
        toolUseId: 'tu-1',
        name: 'Read',
        input: { file_path: '/a.ts' },
        createdAt: NOW,
      },
    });
    expect(result.state.pendingTools['tu-1']).toBeDefined();
  });

  it('combines a tool_result with structuredPatch from tool_use_result', () => {
    let state = createChatReducerState('t1');
    const toolMsg = reduceSdkMessage(state, assistantToolUse('tu-1', 'Edit', { file_path: '/a.ts' }), NOW);
    state = toolMsg.state;

    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }];
    const result = reduceSdkMessage(
      state,
      userToolResult('tu-1', 'ok', { toolUseResult: { structuredPatch: patch } }),
      NOW,
    );

    expect(result.events).toContainEqual({
      type: 'item-upsert',
      item: expect.objectContaining({
        type: 'tool',
        toolUseId: 'tu-1',
        result: 'ok',
        isError: false,
        patch,
      }),
    });
    expect(result.state.pendingTools['tu-1']).toBeUndefined();
  });

  it('emits the output signal only once per state, on first text/tool_use receipt', () => {
    let state = createChatReducerState('t1');
    const r1 = reduceSdkMessage(state, assistantText('Hi'), NOW);
    state = r1.state;
    expect(r1.signals).toContainEqual({ type: 'output' });
    expect(state.outputEmitted).toBe(true);

    const r2 = reduceSdkMessage(state, assistantToolUse('tu-2', 'Bash', { command: 'ls' }), NOW);
    expect(r2.signals).not.toContainEqual({ type: 'output' });
  });

  it('does not emit output for an assistant message with no text/tool_use blocks', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(
      state,
      msg({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }),
      NOW,
    );
    expect(result.signals).toEqual([]);
    expect(result.state.outputEmitted).toBe(false);
  });

  it('emits session-init from a system init message', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(
      state,
      msg({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-42',
        claude_code_version: '2.1.282',
        model: 'claude-sonnet-4-5',
      }),
      NOW,
    );
    expect(result.signals).toEqual([
      { type: 'session-init', sessionId: 'sess-42', cliVersion: '2.1.282', model: 'claude-sonnet-4-5' },
    ]);
  });

  it('emits rate-limit-hit from an api_retry system message with error=rate_limit', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(
      state,
      msg({ type: 'system', subtype: 'api_retry', session_id: 'sess-1', error: 'rate_limit', error_status: 429, retry_delay_ms: 1000 }),
      NOW,
    );
    expect(result.signals).toContainEqual({ type: 'rate-limit-hit' });
  });

  it('does not emit rate-limit-hit for an api_retry with a different error', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(
      state,
      msg({ type: 'system', subtype: 'api_retry', session_id: 'sess-1', error: 'overloaded' }),
      NOW,
    );
    expect(result.signals).not.toContainEqual({ type: 'rate-limit-hit' });
  });

  it('emits rate-limit-hit from an assistant message with error=rate_limit', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(state, assistantText('', 'rate_limit'), NOW);
    expect(result.signals).toContainEqual({ type: 'rate-limit-hit' });
  });

  it('emits auth-failed from an assistant message with error=authentication_failed', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(state, assistantText('', 'authentication_failed'), NOW);
    expect(result.signals).toContainEqual({ type: 'auth-failed' });
  });

  it('emits rate-limit-hit from a result message with api_error_status 429', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(
      state,
      msg({ type: 'result', subtype: 'error_during_execution', session_id: 'sess-1', is_error: true, api_error_status: 429 }),
      NOW,
    );
    expect(result.signals).toContainEqual({ type: 'rate-limit-hit' });
    expect(result.events).toContainEqual({ type: 'turn-end', ok: false, reason: 'rate_limited' });
  });

  it('emits a plain turn-end error (no rate-limit-hit) for a non-429 error result', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(
      state,
      msg({ type: 'result', subtype: 'error_during_execution', session_id: 'sess-1', is_error: true, api_error_status: 500 }),
      NOW,
    );
    expect(result.signals).not.toContainEqual({ type: 'rate-limit-hit' });
    expect(result.events).toContainEqual({ type: 'turn-end', ok: false, reason: 'error' });
  });

  it('emits a successful turn-end for a success result', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(
      state,
      msg({ type: 'result', subtype: 'success', session_id: 'sess-1', is_error: false }),
      NOW,
    );
    expect(result.events).toContainEqual({ type: 'turn-end', ok: true, reason: undefined });
    expect(result.signals).toEqual([]);
  });

  it('emits rate-limit and rate-limit-hit from a rejected rate_limit_event', () => {
    const state = createChatReducerState('t1');
    const info = { status: 'rejected', resetsAt: NOW + 3600, rateLimitType: 'five_hour', utilization: 100 };
    const result = reduceSdkMessage(
      state,
      msg({ type: 'rate_limit_event', session_id: 'sess-1', rate_limit_info: info }),
      NOW,
    );
    expect(result.signals).toContainEqual({ type: 'rate-limit', info });
    expect(result.signals).toContainEqual({ type: 'rate-limit-hit' });
  });

  it('does not emit rate-limit-hit for an allowed_warning rate_limit_event', () => {
    const state = createChatReducerState('t1');
    const info = { status: 'allowed_warning', utilization: 92 };
    const result = reduceSdkMessage(
      state,
      msg({ type: 'rate_limit_event', session_id: 'sess-1', rate_limit_info: info }),
      NOW,
    );
    expect(result.signals).not.toContainEqual({ type: 'rate-limit-hit' });
  });

  it('emits overage when rate_limit_info reports isUsingOverage', () => {
    const state = createChatReducerState('t1');
    const info = { status: 'allowed', isUsingOverage: true, overageResetsAt: NOW + 3600 };
    const result = reduceSdkMessage(
      state,
      msg({ type: 'rate_limit_event', session_id: 'sess-1', rate_limit_info: info }),
      NOW,
    );
    expect(result.signals).toContainEqual({ type: 'overage', info });
  });

  it('emits overage when rate_limit_info reports overageInUse', () => {
    const state = createChatReducerState('t1');
    const info = { status: 'allowed', overageInUse: true };
    const result = reduceSdkMessage(
      state,
      msg({ type: 'rate_limit_event', session_id: 'sess-1', rate_limit_info: info }),
      NOW,
    );
    expect(result.signals).toContainEqual({ type: 'overage', info });
  });

  it('ignores assistant.context_usage entirely (no ctx signal)', () => {
    const state = createChatReducerState('t1');
    const result = reduceSdkMessage(
      state,
      msg({
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ctx report' }] },
        context_usage: { percentage: 42 },
      }),
      NOW,
    );
    expect(result.signals.every((s) => s.type !== ('ctx' as any))).toBe(true);
    expect(result.signals).toContainEqual({ type: 'output' });
  });

  it('createChatReducerState returns a fresh, empty state', () => {
    const state: ChatReducerState = createChatReducerState('thread-9');
    expect(state).toEqual({
      threadId: 'thread-9',
      streamingItemId: null,
      streamingText: '',
      pendingTools: {},
      outputEmitted: false,
      seq: 0,
    });
  });
});

describe('reduceSdkMessage: subagents (parent_tool_use_id) and images', () => {
  it('tags subagent tool_use / text with parentToolUseId and leaves the main streaming item alone', () => {
    let state = createChatReducerState('t1');
    state = reduceSdkMessage(state, textDelta('main '), NOW).state;
    const streamingId = state.streamingItemId;
    // A subagent delta is ignored; its complete text becomes its own item.
    const delta = reduceSdkMessage(state, msg({ type: 'stream_event', parent_tool_use_id: 'A', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } } }), NOW);
    expect(delta.events).toEqual([]);
    const sub = reduceSdkMessage(delta.state, msg({ type: 'assistant', parent_tool_use_id: 'A', message: { content: [{ type: 'text', text: 'sub text' }, { type: 'tool_use', id: 'c1', name: 'Read', input: {} }] } }), NOW);
    expect(sub.state.streamingItemId).toBe(streamingId);
    expect(sub.state.streamingText).toBe('main ');
    const items = sub.events.flatMap((e) => (e.type === 'item-upsert' ? [e.item] : []));
    expect(items.map((i) => [i.type, (i as { parentToolUseId?: string }).parentToolUseId])).toEqual([
      ['assistant-text', 'A'],
      ['tool', 'A'],
    ]);
    expect(items[0]!.id).not.toBe(streamingId);
  });

  it('sets completedAt on a tool result and keeps top-level items free of parentToolUseId', () => {
    let state = createChatReducerState('t1');
    const use = reduceSdkMessage(state, assistantToolUse('tu-1', 'Bash', { command: 'ls' }), NOW);
    expect((use.events[0] as any).item).not.toHaveProperty('parentToolUseId');
    state = use.state;
    const done = reduceSdkMessage(state, userToolResult('tu-1', 'ok'), NOW + 500);
    expect((done.events[0] as any).item.completedAt).toBe(NOW + 500);
  });

  it('extracts base64 image blocks of a tool_result (and the Read structured output fallback)', () => {
    let state = createChatReducerState('t1');
    state = reduceSdkMessage(state, assistantToolUse('img', 'Read', { file_path: 'a.png' }), NOW).state;
    const blockResult = reduceSdkMessage(
      state,
      msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'img', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'caption' }] }] } }),
      NOW,
    );
    expect((blockResult.events[0] as any).item).toMatchObject({ result: 'caption', images: [{ mediaType: 'image/png', data: 'AAAA' }] });

    let s2 = createChatReducerState('t1');
    s2 = reduceSdkMessage(s2, assistantToolUse('img2', 'Read', { file_path: 'b.webp' }), NOW).state;
    const fallback = reduceSdkMessage(s2, userToolResult('img2', '', { toolUseResult: { type: 'image', file: { base64: 'BBBB', type: 'image/webp', originalSize: 3 } } }), NOW);
    expect((fallback.events[0] as any).item.images).toEqual([{ mediaType: 'image/webp', data: 'BBBB' }]);
  });

  it('drops images of unknown media types or over the size cap', () => {
    let state = createChatReducerState('t1');
    state = reduceSdkMessage(state, assistantToolUse('x', 'Read', {}), NOW).state;
    const r = reduceSdkMessage(
      state,
      msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'AAAA' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      ] }] } }),
      NOW,
    );
    expect((r.events[0] as any).item).not.toHaveProperty('images');
  });

  it('a background subagent stays running after its launch result until task_notification', () => {
    let state = createChatReducerState('t1');
    state = reduceSdkMessage(state, assistantToolUse('bg', 'Agent', { subagent_type: 'Explore' }), NOW).state;
    const launched = reduceSdkMessage(state, userToolResult('bg', 'Async agent launched', { toolUseResult: { status: 'async_launched', agentId: 'x' } }), NOW + 1);
    expect((launched.events[0] as any).item).toMatchObject({ taskStatus: 'running' });
    expect((launched.events[0] as any).item).not.toHaveProperty('completedAt');
    const settled = reduceSdkMessage(launched.state, msg({ type: 'system', subtype: 'task_notification', task_id: 'x', tool_use_id: 'bg', status: 'completed', output_file: '', summary: '' }), NOW + 9);
    expect((settled.events[0] as any).item).toMatchObject({ toolUseId: 'bg', taskStatus: 'completed', completedAt: NOW + 9 });
    expect(settled.state.backgroundTools?.bg).toBeUndefined();
    // A notification for an unknown tool changes nothing.
    expect(reduceSdkMessage(settled.state, msg({ type: 'system', subtype: 'task_notification', tool_use_id: 'nope', status: 'failed' }), NOW).events).toEqual([]);
  });
});
