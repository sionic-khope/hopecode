// Agent turns as the transcript shows them: each run of agent output (text, tools, galleries, subagents between two
// non-agent items) becomes one turn, and inside it consecutive "quiet" tool calls fold into one group with a one-line
// summary ("명령 8개 실행 · 12s"). Calls that need their own surface -- diffs, a pending permission, image results,
// subagents, the todo list -- stay standalone cards. Pure functions over ChatNode[] so the list and the tests share them.
import type { AssistantTextItem, ChatItem, ToolItem } from '../../../shared/types';
import type { ChatNode } from '../../../core/subagents';
import { SUBAGENT_TOOL_NAMES } from '../../../core/subagents';
import { displayPath } from '../../../core/displayPath';
import { splitAgentWarning } from './agentIssues';

/** Tools that render a diff of their own. */
const DIFF_TOOL_NAMES: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Agent output that opens / continues a turn (a text that is only an agent warning renders as a notice). */
export function isAgentOutput(it: ChatItem | undefined): boolean {
  if (!it) return false;
  if (it.type === 'assistant-text') return splitAgentWarning(it.text)?.rest !== '';
  return it.type === 'tool' || it.type === 'image-gallery';
}

/** true when the call folds into a tool group (a quiet one-line row) rather than keeping its own card. */
export function isGroupableTool(item: ToolItem, pendingToolIds: ReadonlySet<string> = new Set()): boolean {
  if (DIFF_TOOL_NAMES.has(item.name)) return false;
  if ((item.patch?.length ?? 0) > 0 || (item.diffs?.length ?? 0) > 0) return false;
  if ((item.images?.length ?? 0) > 0) return false;
  if (SUBAGENT_TOOL_NAMES.has(item.name) || item.name === 'TodoWrite') return false;
  return !pendingToolIds.has(item.toolUseId);
}

export type TurnSegment =
  | { kind: 'text'; item: AssistantTextItem }
  /** One or more consecutive groupable calls; a single call renders as one row, two or more as a group. */
  | { kind: 'tools'; id: string; tools: ToolItem[] }
  | { kind: 'card'; item: ToolItem }
  | { kind: 'node'; node: ChatNode };

export type TranscriptBlock =
  | { kind: 'turn'; id: string; segments: TurnSegment[] }
  | { kind: 'item'; node: ChatNode };

/**
 * Display tree -> transcript blocks. Consecutive agent output forms one turn (keyed by its first item id, stable
 * while the turn grows); user messages, notices and warning-only texts stay their own blocks.
 */
export function buildTranscript(nodes: readonly ChatNode[], pendingToolIds: ReadonlySet<string> = new Set()): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  let turn: Extract<TranscriptBlock, { kind: 'turn' }> | null = null;
  for (const node of nodes) {
    const item = node.item;
    if (!isAgentOutput(item)) {
      turn = null;
      out.push({ kind: 'item', node });
      continue;
    }
    if (!turn) {
      turn = { kind: 'turn', id: item.id, segments: [] };
      out.push(turn);
    }
    const segments = turn.segments;
    if (node.kind === 'subagent' || item.type === 'image-gallery') {
      segments.push({ kind: 'node', node });
    } else if (item.type === 'assistant-text') {
      segments.push({ kind: 'text', item });
    } else if (item.type === 'tool') {
      if (!isGroupableTool(item, pendingToolIds)) {
        segments.push({ kind: 'card', item });
        continue;
      }
      const last = segments[segments.length - 1];
      if (last?.kind === 'tools') last.tools.push(item);
      else segments.push({ kind: 'tools', id: item.id, tools: [item] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool group summary
// ---------------------------------------------------------------------------

export type ToolKind = 'command' | 'read' | 'search' | 'web' | 'other';

const KIND_OF: Readonly<Record<string, ToolKind>> = {
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
};
const KIND_ORDER: readonly ToolKind[] = ['command', 'read', 'search', 'web', 'other'];
/** Mixed groups: "명령 5 · 파일 읽기 2 · 검색 1". */
const KIND_LABEL: Readonly<Record<ToolKind, string>> = {
  command: '명령',
  read: '파일 읽기',
  search: '검색',
  web: '웹',
  other: '도구',
};
/** Single-kind groups: "명령 8개 실행". */
const KIND_SENTENCE: Readonly<Record<ToolKind, (n: number) => string>> = {
  command: (n) => `명령 ${n}개 실행`,
  read: (n) => `파일 ${n}개 읽기`,
  search: (n) => `검색 ${n}회`,
  web: (n) => `웹 요청 ${n}개`,
  other: (n) => `도구 ${n}개 사용`,
};

export function toolKind(name: string): ToolKind {
  return KIND_OF[name] ?? 'other';
}

export type ToolCallState = 'running' | 'error' | 'done';

export function toolState(item: ToolItem): ToolCallState {
  if (item.result === undefined) return 'running';
  return item.isError ? 'error' : 'done';
}

export interface ToolGroupSummary {
  total: number;
  /** Per kind, most frequent first (ties in KIND_ORDER). */
  counts: { kind: ToolKind; count: number }[];
  failed: number;
  /** The call still running (the latest pending one), null once all settled. */
  running: ToolItem | null;
  /** First start -> last result, once every call settled (null while running or without timestamps). */
  durationMs: number | null;
  state: ToolCallState;
}

export function summarizeToolGroup(tools: readonly ToolItem[]): ToolGroupSummary {
  const byKind = new Map<ToolKind, number>();
  let failed = 0;
  let running: ToolItem | null = null;
  let start = Infinity;
  let end = -Infinity;
  let timed = true;
  for (const t of tools) {
    const kind = toolKind(t.name);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const state = toolState(t);
    if (state === 'error') failed += 1;
    if (state === 'running') running = t;
    start = Math.min(start, t.createdAt);
    if (t.completedAt === undefined) timed = false;
    else end = Math.max(end, t.completedAt);
  }
  const counts = [...byKind.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return {
    total: tools.length,
    counts,
    failed,
    running,
    durationMs: running || !timed || tools.length === 0 ? null : Math.max(0, end - start),
    state: running ? 'running' : failed > 0 ? 'error' : 'done',
  };
}

/** "명령 8개 실행" for one kind, "명령 5 · 파일 읽기 2 · 검색 1" for a mix. */
export function toolGroupLabel(summary: Pick<ToolGroupSummary, 'counts'>): string {
  const [first, ...rest] = summary.counts;
  if (!first) return '';
  if (rest.length === 0) return KIND_SENTENCE[first.kind](first.count);
  return summary.counts.map((c) => `${KIND_LABEL[c.kind]} ${c.count}`).join(' · ');
}

/** A group with a failed call starts expanded (the user sees what broke without a click). */
export function groupStartsOpen(tools: readonly ToolItem[]): boolean {
  return tools.some((t) => toolState(t) === 'error');
}

/** Best-effort one-line summary of a tool_use input, per tool name. */
export function summarizeToolInput(item: ToolItem, cwd?: string | null, home?: string | null): string {
  const { name, input } = item;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const pth = (v: unknown): string | undefined => (typeof v === 'string' ? displayPath(v, cwd, home) : undefined);
  // ACP tool calls carry the agent's own one-line title (plan 2.4); it beats any per-tool guess.
  const title = str(input.title)?.trim();
  if (title) return title;

  switch (name) {
    case 'Read':
    case 'NotebookEdit':
      return pth(input.file_path) ?? pth(input.notebook_path) ?? '';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return pth(input.file_path) ?? '';
    case 'Bash':
      return str(input.command) ?? '';
    case 'Grep':
    case 'Glob': {
      const pattern = str(input.pattern) ?? '';
      const path = pth(input.path);
      return path ? `${pattern}  ·  ${path}` : pattern;
    }
    case 'WebFetch':
    case 'WebSearch':
      return str(input.url) ?? str(input.query) ?? '';
    case 'Task':
      return str(input.description) ?? str(input.subagent_type) ?? '';
    case 'TodoWrite': {
      const todos = input.todos;
      return Array.isArray(todos) ? `${todos.length} item${todos.length === 1 ? '' : 's'}` : '';
    }
    default: {
      const entries = Object.entries(input).slice(0, 2);
      return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ');
    }
  }
}

/** Running summary line: the live call's input on one line (multi-line commands keep their first line). */
export function runningLine(item: ToolItem, cwd?: string | null, home?: string | null): string {
  const text = summarizeToolInput(item, cwd, home).trim();
  const first = text.split('\n', 1)[0] ?? '';
  return first || item.name;
}

/** Settled call / group time: "320ms", "1.4s", "12s", "1m 05s". */
export function formatDuration(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  if (v < 1000) return `${v}ms`;
  if (v < 10_000) return `${(Math.floor(v / 100) / 10).toFixed(1)}s`;
  const total = Math.floor(v / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

/** Settled duration of one call, null while running or without a result time. */
export function toolDurationMs(item: ToolItem): number | null {
  return item.result === undefined || item.completedAt === undefined ? null : Math.max(0, item.completedAt - item.createdAt);
}
