import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { finalizeAcpTurn, initialAcpReducerState, reduceAcpUpdate, settledKey, toolNameFor } from '../../src/core/acpReducer';
import type { AcpReducerState } from '../../src/core/acpTypes';
import type { ChatEvent, ToolItem } from '../../src/shared/types';

const text = (t: string, messageId?: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: t },
  ...(messageId ? { messageId } : {}),
});

/** Feeds updates one by one; returns the final state and every event / signal. */
function run(updates: SessionUpdate[], from: AcpReducerState = initialAcpReducerState('t1', 1)) {
  let state = from;
  const events: ChatEvent[] = [];
  const signals: ReturnType<typeof reduceAcpUpdate>['signals'] = [];
  updates.forEach((u, i) => {
    const r = reduceAcpUpdate(state, u, 1000 + i);
    state = r.state;
    events.push(...r.events);
    signals.push(...r.signals);
  });
  return { state, events, signals };
}

const tools = (events: ChatEvent[]) =>
  events.flatMap((e) => (e.type === 'item-upsert' && e.item.type === 'tool' ? [e.item] : []));

describe('toolNameFor', () => {
  it('maps kinds and falls back to the title', () => {
    expect(toolNameFor('read', 't')).toBe('Read');
    expect(toolNameFor('edit', 't')).toBe('Edit');
    expect(toolNameFor('delete', 't')).toBe('Delete');
    expect(toolNameFor('move', 't')).toBe('Move');
    expect(toolNameFor('search', 't')).toBe('Grep');
    expect(toolNameFor('execute', 't')).toBe('Bash');
    expect(toolNameFor('fetch', 't')).toBe('WebFetch');
    expect(toolNameFor('think', 't')).toBe('Think');
    expect(toolNameFor('switch_mode', 't')).toBe('Mode');
    expect(toolNameFor('other', 'x'.repeat(60))).toBe('x'.repeat(40));
    expect(toolNameFor(null, 'Title')).toBe('Title');
    expect(toolNameFor(undefined, 'Title')).toBe('Title');
  });
});

describe('text streaming', () => {
  it('streams deltas into one item and confirms it at turn end', () => {
    const { state, events } = run([text('안녕'), text('하세요')]);
    const deltas = events.filter((e) => e.type === 'text-delta');
    expect(deltas).toHaveLength(2);
    const id = (deltas[0] as { itemId: string }).itemId;
    expect((deltas[1] as { itemId: string }).itemId).toBe(id);
    expect(state.streamingText).toBe('안녕하세요');
    const fin = finalizeAcpTurn(state, 'end_turn', 2000);
    expect(fin.events).toEqual([
      { type: 'item-upsert', item: { type: 'assistant-text', id, text: '안녕하세요', createdAt: 2000 } },
    ]);
    expect(fin.state.streamingItemId).toBeNull();
  });

  it('a new messageId confirms the previous item and starts a new one', () => {
    const { events } = run([text('a', 'm1'), text('b', 'm1'), text('c', 'm2')]);
    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual(['text-delta', 'text-delta', 'item-upsert', 'text-delta']);
    const upsert = events[2] as Extract<ChatEvent, { type: 'item-upsert' }>;
    expect(upsert.item).toMatchObject({ type: 'assistant-text', text: 'ab' });
    const ids = events.filter((e) => e.type === 'text-delta').map((e) => (e as { itemId: string }).itemId);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('resource_link becomes a markdown link; images are dropped with a single notice', () => {
    const link: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'resource_link', name: 'Doc', uri: 'https://x.test/d' },
    };
    const img: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    };
    const r = run([link, img, img]);
    expect(r.events[0]).toMatchObject({ type: 'text-delta', text: '[Doc](https://x.test/d)' });
    const notices = r.events.filter((e) => e.type === 'item-upsert' && e.item.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(r.state.imageNoticeShown).toBe(true);
  });

  it('ignores thoughts and user chunks', () => {
    const r = run([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
      { sessionUpdate: 'session_info_update' } as SessionUpdate,
      { sessionUpdate: 'available_commands_update', availableCommands: [] } as SessionUpdate,
      { sessionUpdate: 'totally_new' } as unknown as SessionUpdate,
    ]);
    expect(r.events).toEqual([]);
    expect(r.signals).toEqual([]);
  });

  it('does not mutate the input state', () => {
    const s0 = initialAcpReducerState('t1', 1);
    const frozen = JSON.stringify(s0);
    reduceAcpUpdate(s0, text('x'), 1);
    expect(JSON.stringify(s0)).toBe(frozen);
  });
});

describe('tool calls', () => {
  const call: SessionUpdate = {
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    title: 'Run ls',
    kind: 'execute',
    status: 'pending',
    locations: [{ path: '/a' }],
    rawInput: { command: 'ls' },
  };

  it('tool_call confirms streaming text first and registers a pending tool', () => {
    const { events, state } = run([text('pre'), call]);
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'item-upsert', 'item-upsert']);
    expect((events[1] as { item: { type: string } }).item.type).toBe('assistant-text');
    const [tool] = tools(events);
    expect(tool).toMatchObject({
      toolUseId: 'c1',
      name: 'Bash',
      input: { title: 'Run ls', kind: 'execute', locations: [{ path: '/a' }], command: 'ls' },
    });
    expect(tool!.result).toBeUndefined();
    expect(Object.keys(state.pendingTools)).toEqual(['c1']);
    expect(state.streamingItemId).toBeNull();
  });

  it('completed update upserts the same id with the joined text result', () => {
    const { events, state } = run([
      call,
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'a' } },
          { type: 'content', content: { type: 'text', text: 'b' } },
        ],
      },
    ]);
    const [first, done] = tools(events);
    expect(done!.id).toBe(first!.id);
    expect(done).toMatchObject({ result: 'a\nb', completedAt: 1001, name: 'Bash' });
    expect(done!.isError).toBeUndefined();
    expect(state.pendingTools).toEqual({});
  });

  it('falls back to rawOutput, and caps long results', () => {
    const upd = (rawOutput: unknown): SessionUpdate => ({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput });
    expect(tools(run([call, upd('plain')]).events)[1]!.result).toBe('plain');
    expect(tools(run([call, upd({ a: 1 })]).events)[1]!.result).toBe('{"a":1}');
    expect(tools(run([call, upd('x'.repeat(20000))]).events)[1]!.result).toHaveLength(16 * 1024);
  });

  it('failed update marks isError, with a default message', () => {
    const fail = (content?: SessionUpdate extends infer _ ? unknown : never): SessionUpdate =>
      ({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', content }) as SessionUpdate;
    const empty = tools(run([call, fail()]).events)[1]!;
    expect(empty).toMatchObject({ isError: true, result: '실패' });
    const withText = tools(run([call, fail([{ type: 'content', content: { type: 'text', text: 'boom' } }])]).events)[1]!;
    expect(withText).toMatchObject({ isError: true, result: 'boom' });
  });

  it('collects diffs with a size cap and keeps them across later updates', () => {
    const big = 'z'.repeat(256 * 1024 + 5);
    const { events } = run([
      { sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Edit f', kind: 'edit' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'e1',
        status: 'in_progress',
        content: [
          { type: 'diff', path: '/f', newText: 'new' },
          { type: 'diff', path: '/g', oldText: 'old', newText: big },
        ],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed' },
    ]);
    const all = tools(events);
    expect(all[1]!.diffs).toEqual([
      { path: '/f', oldText: '', newText: 'new' },
      { path: '/g', oldText: 'old', newText: 'z'.repeat(256 * 1024), truncated: true },
    ]);
    expect(all[2]!.diffs).toHaveLength(2);
    expect(all[2]!.name).toBe('Edit');
  });

  it('terminal content is reported as unsupported', () => {
    const r = tools(
      run([call, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'terminal', terminalId: 'x' }] }]).events,
    )[1]!;
    expect(r.result).toBe('(terminal 출력은 지원되지 않음)');
  });

  it('title / kind / locations changes update the input and name', () => {
    const r = tools(
      run([
        { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Working' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'x', title: 'Read a.ts', kind: 'read', locations: [{ path: '/a.ts' }] },
      ]).events,
    )[1]!;
    expect(r.name).toBe('Read');
    expect(r.input).toMatchObject({ title: 'Read a.ts', kind: 'read', locations: [{ path: '/a.ts' }] });
  });

  it('oversized rawInput is dropped, non-object rawInput ignored', () => {
    const big = tools(run([{ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'T', rawInput: { s: 'x'.repeat(9000) } }]).events)[0]!;
    expect(big.input).toEqual({ title: 'T', rawInputTruncated: true });
    const str = tools(run([{ sessionUpdate: 'tool_call', toolCallId: 's', title: 'T', rawInput: 'ls' }]).events)[0]!;
    expect(str.input).toEqual({ title: 'T' });
  });

  it('an update for an unknown tool still produces an item', () => {
    const [t] = tools(run([{ sessionUpdate: 'tool_call_update', toolCallId: 'u', status: 'completed', title: 'Late' }]).events);
    expect(t).toMatchObject({ toolUseId: 'u', name: 'Late', result: '' });
  });

  it('item ids are unique across turns', () => {
    const a = tools(run([call], initialAcpReducerState('t1', 1)).events)[0]!;
    const b = tools(run([call], initialAcpReducerState('t1', 2)).events)[0]!;
    expect(a.id).not.toBe(b.id);
  });
});

describe('finalizeAcpTurn', () => {
  const pending = (): AcpReducerState =>
    run([{ sessionUpdate: 'tool_call', toolCallId: 'p', title: 'T', kind: 'read' }, text('tail')]).state;

  it('cancelled and error settle unfinished tools as 중단됨', () => {
    for (const reason of ['cancelled', 'error'] as const) {
      const base = run([{ sessionUpdate: 'tool_call', toolCallId: 'p', title: 'T', kind: 'read' }]).state;
      const fin = finalizeAcpTurn(base, reason, 5000);
      const [t] = tools(fin.events);
      expect(t).toMatchObject({ isError: true, result: '중단됨', completedAt: 5000 });
      expect(fin.state.pendingTools).toEqual({});
    }
  });

  it('end_turn confirms the text and settles tools without an error flag', () => {
    const fin = finalizeAcpTurn(pending(), 'end_turn', 5000);
    expect(fin.events.map((e) => (e.type === 'item-upsert' ? e.item.type : e.type))).toEqual(['assistant-text', 'tool']);
    expect(fin.state.streamingText).toBe('');
  });

  it('end_turn with a dangling tool completes it quietly', () => {
    const base = run([{ sessionUpdate: 'tool_call', toolCallId: 'p', title: 'T' }]).state;
    const [t] = tools(finalizeAcpTurn(base, 'end_turn', 5).events);
    expect(t!.isError).toBeUndefined();
    expect(t!.result).toBe('');
  });
});

describe('plan', () => {
  const entries = [
    { content: 'one', priority: 'high', status: 'completed' },
    { content: 'two', priority: 'medium', status: 'in_progress' },
    { content: 'three', priority: 'low', status: 'pending' },
  ] as const;

  it('upserts a TodoWrite card with the turn-scoped id each time', () => {
    const r = run([{ sessionUpdate: 'plan', entries: [...entries] }, { sessionUpdate: 'plan', entries: [entries[0]] }], initialAcpReducerState('t1', 3));
    const [a, b] = tools(r.events) as [ToolItem, ToolItem];
    expect(a.id).toBe('plan-3');
    expect(b.id).toBe('plan-3');
    expect(a.name).toBe('TodoWrite');
    expect(a.input).toEqual({
      todos: [
        { content: 'one', status: 'completed', activeForm: 'one' },
        { content: 'two', status: 'in_progress', activeForm: 'two' },
        { content: 'three', status: 'pending', activeForm: 'three' },
      ],
    });
    expect(a.result).toBe('[x] one\n[~] two\n[ ] three');
    expect(r.state.pendingTools).toEqual({});
    expect(finalizeAcpTurn(r.state, 'cancelled', 1).events).toEqual([]);
  });

  it('plan_update items behave like plan; file / markdown / removed are ignored', () => {
    const items = run([{ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p', entries: [...entries] } }]);
    expect(tools(items.events)).toHaveLength(1);
    const others = run([
      { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p', markdown: '# x' } },
      { sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'p', path: '/p.md' } },
      { sessionUpdate: 'plan_removed', planId: 'p' },
    ] as SessionUpdate[]);
    expect(others.events).toEqual([]);
  });
});

describe('signals and notices', () => {
  it('mode / config / context signals', () => {
    const r = run([
      { sessionUpdate: 'current_mode_update', currentModeId: 'auto' },
      {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'a',
            options: [{ value: 'a', name: 'A' }, { group: 'g', name: 'G', options: [{ value: 'b', name: 'B' }] }],
            _meta: { secret: 1 },
          },
          { id: 'x', name: 'X', type: 'boolean', currentValue: true },
        ],
      } as unknown as SessionUpdate,
      { sessionUpdate: 'usage_update', used: 25, size: 200 },
      { sessionUpdate: 'usage_update', used: 5, size: 0 },
    ]);
    expect(r.events).toEqual([]);
    expect(r.signals).toEqual([
      { type: 'mode', currentModeId: 'auto' },
      {
        type: 'config',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'a',
            options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
          },
          { id: 'x', name: 'X', category: null, type: 'boolean', currentValue: true },
        ],
      },
      { type: 'context', percent: 12.5 },
    ]);
  });

  it('notice severity maps to the notice level', () => {
    const n = (severity: string): SessionUpdate => ({ sessionUpdate: 'notice', severity, title: 'T', description: 'D' }) as SessionUpdate;
    const levels = run([n('info'), n('warning'), n('error'), n('weird')]).events.map((e) =>
      e.type === 'item-upsert' && e.item.type === 'notice' ? `${e.item.level}:${e.item.text}` : '',
    );
    expect(levels).toEqual(['info:T\nD', 'warn:T\nD', 'error:T\nD', 'info:T\nD']);
  });
});

describe('settled tools (late updates)', () => {
  const call: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Run ls', kind: 'execute', status: 'in_progress' };
  const done: SessionUpdate = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  };

  it('a late update without status merges into the completed card and keeps it completed', () => {
    const r = run([call, done, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'Run ls -la' }]);
    const all = tools(r.events);
    const last = all.at(-1)!;
    expect(new Set(all.map((t) => t.id))).toEqual(new Set(['tool-1-c1']));
    expect(last).toMatchObject({ result: 'ok', completedAt: 1001 });
    expect(last.input.title).toBe('Run ls -la');
    expect(r.state.pendingTools).toEqual({});
  });

  it('an update with the previous turn id after a new turn targets the original item', () => {
    const first = run([call, done]);
    const nextTurn: AcpReducerState = { ...initialAcpReducerState('t1', 2), settledTools: first.state.settledTools };
    const r = run([{ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' }], nextTurn);
    const [item] = tools(r.events);
    expect(item).toMatchObject({ id: 'tool-1-c1', result: 'ok', completedAt: 1001 });
    expect(r.state.pendingTools).toEqual({});
  });

  it('finalize moves unfinished tools into settledTools', () => {
    const r = run([call]);
    const fin = finalizeAcpTurn(r.state, 'cancelled', 5000);
    expect(fin.state.settledTools[settledKey('c1')]).toMatchObject({ isError: true, completedAt: 5000 });
    const late = reduceAcpUpdate(fin.state, { sessionUpdate: 'tool_call_update', toolCallId: 'c1' }, 6000);
    expect(tools(late.events)[0]).toMatchObject({ id: 'tool-1-c1', isError: true, completedAt: 5000 });
  });

  it('eviction drops the oldest settled tool even with integer-like toolCallIds', () => {
    const updates: SessionUpdate[] = [];
    // "500" settles first, then 200 numeric ids that would sort before it as plain object keys.
    for (const id of ['500', ...Array.from({ length: 200 }, (_, i) => String(i))]) {
      updates.push({ sessionUpdate: 'tool_call', toolCallId: id, title: 't', kind: 'read', status: 'completed' });
    }
    const r = run(updates);
    const keys = Object.keys(r.state.settledTools);
    expect(keys).toHaveLength(200);
    expect(keys).not.toContain(settledKey('500'));
    expect(keys[0]).toBe(settledKey('0'));
    expect(keys.at(-1)).toBe(settledKey('199'));
  });

  it('rawInput __proto__ stays a plain key; agent lists and labels are capped', () => {
    const rawInput = JSON.parse('{"__proto__": {"polluted": true}, "command": "ls"}') as Record<string, unknown>;
    const r = run([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c2',
        title: 'T'.repeat(1000),
        kind: 'execute',
        rawInput,
        locations: Array.from({ length: 500 }, (_, i) => ({ path: `/f${i}` })),
        content: Array.from({ length: 80 }, (_, i) => ({ type: 'diff', path: `/d${i}`, oldText: '', newText: 'x' })),
      } as SessionUpdate,
      { sessionUpdate: 'notice', severity: 'info', title: 'N'.repeat(1000) } as unknown as SessionUpdate,
    ]);
    const [item] = tools(r.events);
    expect(Object.getPrototypeOf(item!.input)).toBe(Object.prototype);
    expect((item!.input as { polluted?: unknown }).polluted).toBeUndefined();
    expect(item!.input.command).toBe('ls');
    expect(String(item!.input.title)).toHaveLength(256);
    expect(item!.input.locations).toHaveLength(200);
    expect(item!.diffs).toHaveLength(50);
    const notice = r.events.flatMap((e) => (e.type === 'item-upsert' && e.item.type === 'notice' ? [e.item] : []))[0]!;
    expect(notice.text).toHaveLength(256);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
