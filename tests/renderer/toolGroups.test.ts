import { describe, expect, it } from 'vitest';
import type { ChatItem, ToolItem } from '../../src/shared/types';
import { buildChatTree } from '../../src/core/subagents';
import {
  buildTranscript,
  formatDuration,
  groupStartsOpen,
  isGroupableTool,
  runningLine,
  summarizeToolGroup,
  toolGroupLabel,
  type TranscriptBlock,
  type TurnSegment,
} from '../../src/renderer/components/Chat/toolGroups';

let seq = 0;
function tool(name: string, over: Partial<ToolItem> = {}): ToolItem {
  const n = ++seq;
  return {
    id: `t${n}`,
    type: 'tool',
    toolUseId: `toolu_${n}`,
    name,
    input: name === 'Bash' ? { command: `echo ${n}` } : { file_path: `/repo/f${n}.ts` },
    result: 'ok',
    createdAt: 1000 * n,
    completedAt: 1000 * n + 500,
    ...over,
  } as ToolItem;
}
const text = (t: string): ChatItem => ({ id: `x${++seq}`, type: 'assistant-text', text: t, createdAt: 0 }) as ChatItem;
const user = (t: string): ChatItem => ({ id: `u${++seq}`, type: 'user', text: t, createdAt: 0 }) as ChatItem;

function turns(items: ChatItem[], pending: string[] = []): TranscriptBlock[] {
  return buildTranscript(buildChatTree(items), new Set(pending));
}
/** Segment shape: 'text' / 'card:Edit' / 'tools:3'. */
function shape(segments: TurnSegment[]): string[] {
  return segments.map((s) =>
    s.kind === 'tools' ? `tools:${s.tools.length}` : s.kind === 'card' ? `card:${s.item.name}` : s.kind === 'text' ? 'text' : 'node',
  );
}

describe('buildTranscript', () => {
  it('folds consecutive quiet calls into one group and keeps text between groups', () => {
    const items = [user('hi'), text('a'), tool('Bash'), tool('Bash'), tool('Read'), text('b'), tool('Grep'), text('c')];
    const blocks = turns(items);
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'turn']);
    const turn = blocks[1] as Extract<TranscriptBlock, { kind: 'turn' }>;
    expect(shape(turn.segments)).toEqual(['text', 'tools:3', 'text', 'tools:1', 'text']);
    // Keyed by the first item: the group keeps its id while it grows.
    const group = turn.segments[1] as Extract<TurnSegment, { kind: 'tools' }>;
    expect(group.id).toBe(group.tools[0]!.id);
    expect(turn.id).toBe(items[1]!.id);
  });

  it('a user message or notice ends the turn', () => {
    const notice = { id: 'n1', type: 'notice', level: 'info', text: 'x', createdAt: 0 } as ChatItem;
    const blocks = turns([tool('Bash'), tool('Bash'), notice, tool('Bash'), user('again'), tool('Bash')]);
    expect(blocks.map((b) => (b.kind === 'turn' ? `turn:${shape(b.segments).join(',')}` : b.node.item.type))).toEqual([
      'turn:tools:2',
      'notice',
      'turn:tools:1',
      'user',
      'turn:tools:1',
    ]);
  });

  it('diff, pending-permission, image, subagent and todo calls stay cards and split the group', () => {
    const edit = tool('Edit');
    const write = tool('Write');
    const withPatch = tool('Bash', { patch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] });
    const withDiffs = tool('Mode', { diffs: [{ path: 'a', oldText: '', newText: 'b' }] });
    const pending = tool('Bash', { result: undefined });
    const shot = tool('mcp__playwright__browser_take_screenshot', { images: [{ mediaType: 'image/png', data: 'x' }] as never });
    const task = tool('Task', { input: { description: 'look' } });
    const todo = tool('TodoWrite', { input: { todos: [] } });
    const items = [tool('Bash'), edit, tool('Read'), tool('Read'), write, withPatch, withDiffs, pending, shot, task, todo, tool('Glob')];
    const turn = turns(items, [pending.toolUseId])[0] as Extract<TranscriptBlock, { kind: 'turn' }>;
    expect(shape(turn.segments)).toEqual([
      'tools:1',
      'card:Edit',
      'tools:2',
      'card:Write',
      'card:Bash',
      'card:Mode',
      'card:Bash',
      'card:mcp__playwright__browser_take_screenshot',
      'node',
      'card:TodoWrite',
      'tools:1',
    ]);
    expect(isGroupableTool(pending)).toBe(true);
    expect(isGroupableTool(pending, new Set([pending.toolUseId]))).toBe(false);
    expect(isGroupableTool(tool('NotebookEdit'))).toBe(false);
    expect(isGroupableTool(tool('MultiEdit'))).toBe(false);
  });

  it('subagent child calls nest under their card, not in the group', () => {
    const task = tool('Agent', { input: { subagent_type: 'Explore' } });
    const child = tool('Read', { parentToolUseId: task.toolUseId });
    const turn = turns([tool('Bash'), task, child, tool('Bash')])[0] as Extract<TranscriptBlock, { kind: 'turn' }>;
    expect(shape(turn.segments)).toEqual(['tools:1', 'node', 'tools:1']);
  });

  it('a warning-only text is its own block, a warning before an answer stays in the turn', () => {
    const warningOnly = text('Model metadata for `gpt-x` not found. Defaulting to fallback metadata; this can degrade performance.');
    const blocks = turns([warningOnly, tool('Bash')]);
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'turn']);
  });
});

describe('summarizeToolGroup / toolGroupLabel', () => {
  it('one kind reads as a sentence, mixes count per kind (most first)', () => {
    const bash = Array.from({ length: 8 }, () => tool('Bash'));
    expect(toolGroupLabel(summarizeToolGroup(bash))).toBe('명령 8개 실행');
    expect(toolGroupLabel(summarizeToolGroup([tool('Read'), tool('Read')]))).toBe('파일 2개 읽기');
    expect(toolGroupLabel(summarizeToolGroup([tool('Grep'), tool('Glob')]))).toBe('검색 2회');
    expect(toolGroupLabel(summarizeToolGroup([tool('mcp__x__y'), tool('Think')]))).toBe('도구 2개 사용');
    const mixed = [tool('Grep'), tool('Bash'), tool('Read'), tool('Bash'), tool('Bash'), tool('Read'), tool('Bash'), tool('Bash')];
    expect(toolGroupLabel(summarizeToolGroup(mixed))).toBe('명령 5 · 파일 읽기 2 · 검색 1');
    // Ties keep the fixed kind order (명령, 파일 읽기, 검색, 웹, 도구).
    expect(toolGroupLabel(summarizeToolGroup([tool('WebFetch'), tool('Read')]))).toBe('파일 읽기 1 · 웹 1');
  });

  it('settled group: done state and first start -> last result duration', () => {
    const a = tool('Bash', { createdAt: 10_000, completedAt: 11_000 });
    const b = tool('Bash', { createdAt: 11_000, completedAt: 22_000 });
    const s = summarizeToolGroup([a, b]);
    expect(s).toMatchObject({ total: 2, failed: 0, running: null, state: 'done', durationMs: 12_000 });
    expect(formatDuration(s.durationMs!)).toBe('12s');
  });

  it('failures: counted, error state, the group starts open', () => {
    const tools = [tool('Bash'), tool('Bash', { isError: true }), tool('Read')];
    const s = summarizeToolGroup(tools);
    expect(s.failed).toBe(1);
    expect(s.state).toBe('error');
    expect(groupStartsOpen(tools)).toBe(true);
    expect(groupStartsOpen([tool('Bash'), tool('Bash')])).toBe(false);
  });

  it('running: the latest pending call is the live one, no duration yet', () => {
    const done = tool('Bash');
    const live = tool('Bash', { result: undefined, completedAt: undefined, input: { command: 'npm test\n  --run' } });
    const s = summarizeToolGroup([done, live]);
    expect(s.state).toBe('running');
    expect(s.running).toBe(live);
    expect(s.durationMs).toBeNull();
    expect(runningLine(live)).toBe('npm test');
    expect(runningLine(tool('Read', { input: { file_path: '/repo/src/a.ts' } }), '/repo')).toBe('src/a.ts');
    expect(runningLine(tool('Mystery', { input: {} }))).toBe('Mystery');
  });

  it('formatDuration', () => {
    expect(formatDuration(320)).toBe('320ms');
    expect(formatDuration(1_450)).toBe('1.4s');
    expect(formatDuration(9_999)).toBe('9.9s');
    expect(formatDuration(12_300)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });
});
