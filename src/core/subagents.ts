// Subagent routing (SDK `parent_tool_use_id`): groups the items a subagent produced under the Task/Agent tool
// card that started it. Pure functions over ChatItem[] so the chat list, the env popover and tests share them.
import type { ChatItem, ToolItem } from '../shared/types';

/** Tool names that start a subagent (`Agent` in current CLIs, `Task` in older ones). */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent']);

export type SubagentState = 'running' | 'done' | 'failed';

export interface SubagentSummary {
  toolUseId: string;
  itemId: string;
  /** `input.subagent_type` (the CLI's default agent when omitted). */
  subagentType: string;
  /** `input.description` (short task label), '' when missing. */
  description: string;
  state: SubagentState;
  startedAt: number;
  /** epoch ms the run settled; null while running. */
  endedAt: number | null;
  /** Tool calls made inside the subagent (nested subagents' calls included). */
  childToolCount: number;
  /** Nesting depth: 0 for a subagent started by the main conversation. */
  depth: number;
}

export type ChatNode =
  | { kind: 'item'; item: ChatItem }
  | { kind: 'subagent'; item: ToolItem; summary: SubagentSummary; children: ChatNode[] };

export const DEFAULT_SUBAGENT_TYPE = 'general-purpose';

export function isSubagentTool(item: ChatItem): item is ToolItem {
  return item.type === 'tool' && SUBAGENT_TOOL_NAMES.has(item.name);
}

export function subagentState(item: ToolItem): SubagentState {
  if (item.taskStatus) {
    if (item.taskStatus === 'running') return 'running';
    return item.taskStatus === 'completed' ? 'done' : 'failed';
  }
  if (item.result === undefined) return 'running';
  return item.isError ? 'failed' : 'done';
}

export function subagentType(item: ToolItem): string {
  const type = item.input.subagent_type;
  return typeof type === 'string' && type.trim() ? type.trim() : DEFAULT_SUBAGENT_TYPE;
}

function parentOf(item: ChatItem): string | undefined {
  return item.type === 'tool' || item.type === 'assistant-text' ? item.parentToolUseId : undefined;
}

/**
 * Chat items -> display tree. Items whose `parentToolUseId` names a subagent tool present in `items` nest under
 * it (at any depth, whatever order they arrived in); everything else, including children of an unknown parent,
 * stays top-level in its original order.
 */
export function buildChatTree(items: readonly ChatItem[]): ChatNode[] {
  const subagents = new Map<string, ToolItem>();
  for (const item of items) if (isSubagentTool(item)) subagents.set(item.toolUseId, item);

  /** true when nesting `item` under `parent` would make a subagent its own ancestor. */
  const cycles = (item: ChatItem, parent: string): boolean => {
    if (!isSubagentTool(item)) return false;
    const seen = new Set<string>();
    let cur: string | undefined = parent;
    while (cur && !seen.has(cur)) {
      if (cur === item.toolUseId) return true;
      seen.add(cur);
      const next = subagents.get(cur);
      cur = next ? parentOf(next) : undefined;
    }
    return cur !== undefined;
  };

  const children = new Map<string, ChatItem[]>();
  const top: ChatItem[] = [];
  for (const item of items) {
    const parent = parentOf(item);
    if (parent && subagents.has(parent) && !cycles(item, parent)) {
      const list = children.get(parent);
      if (list) list.push(item);
      else children.set(parent, [item]);
    } else {
      top.push(item);
    }
  }

  const build = (item: ChatItem, depth: number): ChatNode => {
    if (!isSubagentTool(item)) return { kind: 'item', item };
    const nodes = (children.get(item.toolUseId) ?? []).map((child) => build(child, depth + 1));
    const state = subagentState(item);
    const input = item.input;
    return {
      kind: 'subagent',
      item,
      children: nodes,
      summary: {
        toolUseId: item.toolUseId,
        itemId: item.id,
        subagentType: subagentType(item),
        description: typeof input.description === 'string' ? input.description : '',
        state,
        startedAt: item.createdAt,
        endedAt: state === 'running' ? null : (item.completedAt ?? null),
        childToolCount: countTools(nodes),
        depth,
      },
    };
  };
  return top.map((item) => build(item, 0));
}

function countTools(nodes: readonly ChatNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind === 'subagent') n += 1 + node.summary.childToolCount;
    else if (node.item.type === 'tool') n += 1;
  }
  return n;
}

/** Every subagent in the transcript (nested ones included), in start order. */
export function collectSubagents(items: readonly ChatItem[]): SubagentSummary[] {
  const out: SubagentSummary[] = [];
  const walk = (nodes: readonly ChatNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'subagent') continue;
      out.push(node.summary);
      walk(node.children);
    }
  };
  walk(buildChatTree(items));
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
