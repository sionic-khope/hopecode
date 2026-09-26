import { describe, expect, it } from 'vitest';
import { buildChatTree, collectSubagents, subagentState, type ChatNode } from '../../src/core/subagents';
import { createChatReducerState, reduceSdkMessage, type SdkMessageLike } from '../../src/core/chatReducer';
import type { ChatItem, ToolItem } from '../../src/shared/types';

let seq = 0;
function tool(toolUseId: string, name: string, extra: Partial<ToolItem> = {}): ToolItem {
  return { type: 'tool', id: `tool-${seq++}`, toolUseId, name, input: {}, createdAt: 1000 + seq, ...extra };
}
function agent(toolUseId: string, type: string, extra: Partial<ToolItem> = {}): ToolItem {
  return tool(toolUseId, 'Agent', { input: { subagent_type: type, description: `${type} task` }, ...extra });
}
function text(t: string, parentToolUseId?: string): ChatItem {
  return { type: 'assistant-text', id: `text-${seq++}`, text: t, createdAt: 1000 + seq, ...(parentToolUseId ? { parentToolUseId } : {}) };
}
function shape(nodes: ChatNode[]): unknown[] {
  return nodes.map((n) =>
    n.kind === 'subagent'
      ? { agent: n.item.toolUseId, children: shape(n.children) }
      : n.item.type === 'tool'
        ? n.item.toolUseId
        : n.item.type === 'assistant-text'
          ? n.item.text
          : n.item.type,
  );
}

describe('buildChatTree (parent_tool_use_id grouping)', () => {
  it('groups interleaved frames of two parallel subagents under their own cards', () => {
    const items: ChatItem[] = [
      text('intro'),
      agent('A', 'Explore'),
      agent('B', 'code-reviewer'),
      tool('a1', 'Read', { parentToolUseId: 'A' }),
      tool('b1', 'Grep', { parentToolUseId: 'B' }),
      text('a says', 'A'),
      tool('a2', 'Glob', { parentToolUseId: 'A' }),
      text('b says', 'B'),
      text('outro'),
    ];
    expect(shape(buildChatTree(items))).toEqual([
      'intro',
      { agent: 'A', children: ['a1', 'a says', 'a2'] },
      { agent: 'B', children: ['b1', 'b says'] },
      'outro',
    ]);
  });

  it('nests a subagent started inside another subagent and counts every tool below', () => {
    const items: ChatItem[] = [
      agent('A', 'planner'),
      tool('a1', 'Read', { parentToolUseId: 'A' }),
      agent('A2', 'Explore', { parentToolUseId: 'A' }),
      tool('x1', 'Grep', { parentToolUseId: 'A2' }),
      tool('x2', 'Read', { parentToolUseId: 'A2' }),
    ];
    const tree = buildChatTree(items);
    expect(shape(tree)).toEqual([{ agent: 'A', children: ['a1', { agent: 'A2', children: ['x1', 'x2'] }] }]);
    const top = tree[0] as Extract<ChatNode, { kind: 'subagent' }>;
    expect(top.summary.childToolCount).toBe(4); // a1 + A2 + x1 + x2
    expect(collectSubagents(items).map((s) => [s.toolUseId, s.depth])).toEqual([
      ['A', 0],
      ['A2', 1],
    ]);
  });

  it('groups children that arrive before their parent card (history merge order)', () => {
    const items: ChatItem[] = [tool('a1', 'Read', { parentToolUseId: 'A' }), text('main'), agent('A', 'Explore')];
    expect(shape(buildChatTree(items))).toEqual(['main', { agent: 'A', children: ['a1'] }]);
  });

  it('keeps children of an unknown parent top-level and breaks parent cycles', () => {
    const items: ChatItem[] = [
      tool('o1', 'Read', { parentToolUseId: 'missing' }),
      agent('P', 'x', { parentToolUseId: 'Q' }),
      agent('Q', 'y', { parentToolUseId: 'P' }),
    ];
    const flat = shape(buildChatTree(items));
    expect(flat[0]).toBe('o1');
    // Both subagents still render exactly once.
    expect(JSON.stringify(flat).match(/"agent"/g)?.length).toBe(2);
  });

  it('derives state: running without result, failed on error, background task via taskStatus', () => {
    expect(subagentState(agent('A', 't'))).toBe('running');
    expect(subagentState(agent('A', 't', { result: 'ok', isError: false }))).toBe('done');
    expect(subagentState(agent('A', 't', { result: 'boom', isError: true }))).toBe('failed');
    expect(subagentState(agent('A', 't', { result: 'launched', taskStatus: 'running' }))).toBe('running');
    expect(subagentState(agent('A', 't', { result: 'launched', taskStatus: 'completed' }))).toBe('done');
    expect(subagentState(agent('A', 't', { result: 'launched', taskStatus: 'stopped' }))).toBe('failed');
  });

  it('summary carries type, description, start/end and falls back to general-purpose', () => {
    const [s] = collectSubagents([tool('T', 'Task', { input: {}, createdAt: 10, result: 'done', completedAt: 70 })]);
    expect(s).toMatchObject({ subagentType: 'general-purpose', description: '', state: 'done', startedAt: 10, endedAt: 70 });
  });
});

function msg(m: Record<string, unknown>): SdkMessageLike {
  return m as unknown as SdkMessageLike;
}

describe('reduceSdkMessage + buildChatTree (SDK frames end to end)', () => {
  it('parallel subagents with mixed completion order', () => {
    let state = createChatReducerState('t');
    const items = new Map<string, ChatItem>();
    const feed = (m: Record<string, unknown>, now = 5) => {
      const r = reduceSdkMessage(state, msg(m), now);
      state = r.state;
      for (const e of r.events) if (e.type === 'item-upsert') items.set(e.item.id, e.item);
    };
    const use = (id: string, name: string, parent: string | null, input: Record<string, unknown> = {}) =>
      feed({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id: string, parent: string | null, now = 5) =>
      feed({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }, now);

    use('A', 'Agent', null, { subagent_type: 'Explore' });
    use('B', 'Agent', null, { subagent_type: 'code-reviewer' });
    use('a1', 'Read', 'A');
    use('b1', 'Grep', 'B');
    result('a1', 'A');
    feed({ type: 'assistant', parent_tool_use_id: 'B', message: { content: [{ type: 'text', text: 'b note' }] } });
    result('b1', 'B');
    result('B', null, 9);
    result('A', null, 12);

    const tree = buildChatTree([...items.values()]);
    expect(shape(tree)).toEqual([
      { agent: 'A', children: ['a1'] },
      { agent: 'B', children: ['b1', 'b note'] },
    ]);
    const summaries = collectSubagents([...items.values()]);
    expect(summaries.map((s) => [s.toolUseId, s.state, s.endedAt])).toEqual([
      ['A', 'done', 12],
      ['B', 'done', 9],
    ]);
  });
});
