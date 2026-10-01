// ACP `session/update` -> ChatEvent mapping (plan 2.4). Pure: the SDK is imported for types only.
import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import type { AcpCommandLite, ChatEvent, ChatImage, ChatItem, ToolFileDiff, ToolItem } from '../shared/types';
import { acpToolImages, mcpBlocks, mcpText, toAgentImage } from './agentImages';
import type {
  AcpReducerState,
  AcpReduceResult,
  AcpSignal,
  FinalizeAcpTurnFn,
  InitialAcpReducerStateFn,
  ReduceAcpUpdateFn,
  ToolNameForFn,
} from './acpTypes';

const MAX_RAW_INPUT_CHARS = 8 * 1024;
const MAX_RESULT_CHARS = 16 * 1024;
const MAX_DIFF_CHARS = 256 * 1024;
/** Caps on agent-supplied lists / labels (a misbehaving agent cannot flood the store or the UI). */
const MAX_LIST_ITEMS = 200;
const MAX_DIFFS = 50;
export const MAX_LABEL_CHARS = 256;
/** Settled tools remembered for late updates. */
const MAX_SETTLED_TOOLS = 200;
const INTERRUPTED_TEXT = '중단됨';
const FAILED_TEXT = '실패';
const TERMINAL_TEXT = '(terminal 출력은 지원되지 않음)';
/** codex-acp collab tool that starts a subagent (`collabAgentToolCall`, tool `spawnAgent`). */
const CODEX_SPAWN_TITLE = 'spawnAgent';
/** Subagent type the card / sprite shows for a Codex-spawned agent. */
export const CODEX_SUBAGENT_TYPE = 'codex-agent';

export const initialAcpReducerState: InitialAcpReducerStateFn = (threadId, turn) => ({
  threadId,
  turn,
  streamingItemId: null,
  streamingMessageId: null,
  streamingText: '',
  pendingTools: {},
  settledTools: {},
  seq: 0,
});

const TOOL_NAMES: Readonly<Record<string, string>> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Grep',
  execute: 'Bash',
  fetch: 'WebFetch',
  think: 'Think',
  switch_mode: 'Mode',
};

export const toolNameFor: ToolNameForFn = (kind, title) =>
  title === CODEX_SPAWN_TITLE ? 'Agent' : (kind && TOOL_NAMES[kind]) || title.slice(0, 40);

const cap = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface ToolContentLike {
  type?: unknown;
  content?: { type?: unknown; text?: unknown };
  path?: unknown;
  oldText?: unknown;
  newText?: unknown;
}

function toolContentArray(content: unknown): ToolContentLike[] {
  return Array.isArray(content) ? content.filter((c): c is ToolContentLike => isRecord(c)) : [];
}

function contentText(content: ToolContentLike[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === 'content' && c.content?.type === 'text' && typeof c.content.text === 'string') {
      parts.push(c.content.text);
    } else if (c.type === 'terminal') {
      parts.push(TERMINAL_TEXT);
    }
  }
  return cap(parts.join('\n'), MAX_RESULT_CHARS);
}

function contentDiffs(content: ToolContentLike[]): ToolFileDiff[] {
  const diffs: ToolFileDiff[] = [];
  for (const c of content) {
    if (diffs.length >= MAX_DIFFS) break;
    if (c.type !== 'diff' || typeof c.path !== 'string' || typeof c.newText !== 'string') continue;
    const oldText = typeof c.oldText === 'string' ? c.oldText : '';
    const truncated = oldText.length > MAX_DIFF_CHARS || c.newText.length > MAX_DIFF_CHARS;
    diffs.push({
      path: c.path,
      oldText: cap(oldText, MAX_DIFF_CHARS),
      newText: cap(c.newText, MAX_DIFF_CHARS),
      ...(truncated ? { truncated: true } : {}),
    });
  }
  return diffs;
}

function rawOutputText(rawOutput: unknown): string {
  if (rawOutput === undefined || rawOutput === null) return '';
  // An MCP result (screenshots): its text blocks, never a JSON dump with the base64 image inside.
  if (mcpBlocks(rawOutput).length > 0) return cap(mcpText(rawOutput), MAX_RESULT_CHARS);
  if (typeof rawOutput === 'string') return cap(rawOutput, MAX_RESULT_CHARS);
  try {
    return cap(JSON.stringify(rawOutput) ?? '', MAX_RESULT_CHARS);
  } catch {
    return '';
  }
}

/** `{title, kind, locations}` plus the agent's rawInput when it is a small object. */
function buildInput(
  prev: Record<string, unknown> | undefined,
  src: { title?: string | null; kind?: string | null; locations?: unknown; rawInput?: unknown },
): Record<string, unknown> {
  let input: Record<string, unknown> = { ...(prev ?? {}) };
  if (isRecord(src.rawInput)) {
    let size = Infinity;
    try {
      size = JSON.stringify(src.rawInput).length;
    } catch {
      /* circular / unserializable: dropped below */
    }
    // Spread (not Object.assign): an own `__proto__` key stays a plain property.
    if (size <= MAX_RAW_INPUT_CHARS) input = { ...input, ...src.rawInput };
    else input.rawInputTruncated = true;
  }
  if (typeof src.title === 'string') input.title = cap(src.title, MAX_LABEL_CHARS);
  if (typeof src.kind === 'string') input.kind = cap(src.kind, MAX_LABEL_CHARS);
  if (Array.isArray(src.locations)) input.locations = src.locations.slice(0, MAX_LIST_ITEMS);
  if (input.title === CODEX_SPAWN_TITLE) {
    // Subagent card fields (core/subagents): type, short task label, the full prompt for the detail view.
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    input.subagent_type = CODEX_SUBAGENT_TYPE;
    input.description = cap(prompt.split('\n')[0]?.trim() ?? '', 80);
  }
  return input;
}

/** codex `agentsStates` entry -> chat state of the spawned agent (null: not a state we know). */
function collabState(state: unknown): { taskStatus: NonNullable<ToolItem['taskStatus']>; message: string } | null {
  if (!isRecord(state) || typeof state.status !== 'string') return null;
  const message = typeof state.message === 'string' ? cap(state.message, MAX_RESULT_CHARS) : '';
  switch (state.status) {
    case 'pendingInit':
    case 'running':
      return { taskStatus: 'running', message };
    case 'completed':
    case 'shutdown':
      return { taskStatus: 'completed', message };
    case 'errored':
    case 'notFound':
      return { taskStatus: 'failed', message };
    case 'interrupted':
      return { taskStatus: 'stopped', message };
    default:
      return null;
  }
}

/** Images of a tool call update, falling back to the card's earlier ones. */
function toolImages(content: unknown, rawOutput: unknown, prev: ChatImage[] | undefined): { images?: ChatImage[] } {
  const images = acpToolImages(content, rawOutput);
  if (images.length > 0) return { images };
  return prev ? { images: prev } : {};
}

const MAX_COMMAND_NAME_CHARS = 64;
const MAX_COMMAND_DESCRIPTION_CHARS = 1000;

/**
 * Agent-advertised slash commands, read defensively: a name is one token without the slash (a leading `/` is
 * dropped), duplicates and malformed rows are skipped, everything is capped.
 */
export function toLiteCommands(raw: readonly unknown[]): AcpCommandLite[] {
  const out: AcpCommandLite[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (out.length >= MAX_LIST_ITEMS) break;
    if (!isRecord(c) || typeof c.name !== 'string') continue;
    const name = c.name.trim().replace(/^\//, '');
    if (!name || /\s/.test(name) || name.length > MAX_COMMAND_NAME_CHARS || seen.has(name)) continue;
    seen.add(name);
    const hint = isRecord(c.input) && typeof c.input.hint === 'string' ? c.input.hint.trim() : '';
    out.push({
      name,
      description: typeof c.description === 'string' ? cap(c.description, MAX_COMMAND_DESCRIPTION_CHARS) : '',
      hint: hint ? cap(hint, MAX_LABEL_CHARS) : null,
    });
  }
  return out;
}

const checklistMark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' } as const;

function planItem(state: AcpReducerState, entries: unknown, now: number): ToolItem | null {
  if (!Array.isArray(entries)) return null;
  const rows = entries.filter(isRecord).map((e) => {
    const content = typeof e.content === 'string' ? e.content : '';
    const status = e.status === 'completed' || e.status === 'in_progress' ? e.status : 'pending';
    return { content, status } as const;
  });
  const id = `plan-${state.turn}`;
  return {
    type: 'tool',
    id,
    toolUseId: id,
    name: 'TodoWrite',
    input: { todos: rows.map((r) => ({ content: r.content, status: r.status, activeForm: r.content })) },
    result: rows.map((r) => `${checklistMark[r.status]} ${r.content}`).join('\n'),
    createdAt: now,
  };
}

/**
 * settledTools key: prefixed so integer-like toolCallIds ("12") keep insertion order (JS orders integer keys first),
 * which the oldest-first eviction relies on.
 */
export const settledKey = (toolCallId: string): string => `id:${toolCallId}`;

/** Remembers a settled tool (oldest dropped past MAX_SETTLED_TOOLS). */
function withSettled(settled: Record<string, ToolItem>, toolCallId: string, item: ToolItem): Record<string, ToolItem> {
  const key = settledKey(toolCallId);
  const { [key]: _old, ...rest } = settled;
  const next = { ...rest, [key]: item };
  const keys = Object.keys(next);
  if (keys.length > MAX_SETTLED_TOOLS) delete next[keys[0] as string];
  return next;
}

export const reduceAcpUpdate: ReduceAcpUpdateFn = (state, update, now): AcpReduceResult => {
  let next: AcpReducerState = { ...state, pendingTools: { ...state.pendingTools } };
  const events: ChatEvent[] = [];
  const signals: AcpSignal[] = [];

  const allocId = (prefix: string): string => {
    const id = `${prefix}-${next.turn}-${next.seq}`;
    next = { ...next, seq: next.seq + 1 };
    return id;
  };

  /** Confirms the streaming assistant text item (its final text) and ends the run. */
  const settleText = () => {
    if (next.streamingItemId) {
      events.push({
        type: 'item-upsert',
        item: { type: 'assistant-text', id: next.streamingItemId, text: next.streamingText, createdAt: now },
      });
    }
    next = { ...next, streamingItemId: null, streamingMessageId: null, streamingText: '' };
  };

  const appendText = (text: string, messageId: string | null | undefined) => {
    if (next.streamingItemId && messageId && next.streamingMessageId && messageId !== next.streamingMessageId) {
      settleText();
    }
    if (!next.streamingItemId) {
      const id = allocId('text');
      next = { ...next, streamingItemId: id, streamingText: '', streamingMessageId: messageId ?? null };
    } else if (messageId && !next.streamingMessageId) {
      next = { ...next, streamingMessageId: messageId };
    }
    next = { ...next, streamingText: next.streamingText + text };
    events.push({ type: 'text-delta', itemId: next.streamingItemId as string, text });
  };

  const pushNotice = (level: 'info' | 'warn' | 'error', text: string) => {
    const item: ChatItem = { type: 'notice', id: allocId('notice'), level, text, createdAt: now };
    events.push({ type: 'item-upsert', item });
  };

  const upsertPlan = (entries: unknown) => {
    const item = planItem(next, entries, now);
    if (item) events.push({ type: 'item-upsert', item });
  };

  /**
   * Codex collab calls report every agent they touch in `agentsStates` (`{<threadId>: {status, message}}`): the card
   * of the `spawnAgent` call that started that agent follows it (running / done with its last message / failed).
   * The spawn card itself only takes terminal states (it settles as soon as the agent was started).
   */
  const syncSpawned = (source: ToolItem) => {
    const states = source.input.agentsStates;
    if (!isRecord(states)) return;
    const isSpawn = source.input.title === CODEX_SPAWN_TITLE;
    for (const [childId, raw] of Object.entries(states)) {
      const state = collabState(raw);
      if (!state || (isSpawn && state.taskStatus === 'running')) continue;
      const spawn = isSpawn ? source : findSpawn(next, childId);
      if (!spawn || spawn.result === undefined) continue;
      const updated: ToolItem = {
        ...spawn,
        taskStatus: state.taskStatus,
        ...(state.message ? { result: state.message } : {}),
        ...(state.taskStatus === 'running' ? {} : { completedAt: now }),
      };
      if (spawn.taskStatus === updated.taskStatus && spawn.result === updated.result) continue;
      next = { ...next, settledTools: withSettled(next.settledTools, spawn.toolUseId, updated) };
      events.push({ type: 'item-upsert', item: updated });
    }
  };

  const u = update as Record<string, any>;

  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const block = u.content;
      if (block?.type === 'text' && typeof block.text === 'string') {
        appendText(block.text, u.messageId);
      } else if (block?.type === 'resource_link' && typeof block.uri === 'string') {
        const name = typeof block.name === 'string' && block.name ? block.name : block.uri;
        appendText(`[${name}](${block.uri})`, u.messageId);
      } else if (block?.type === 'image') {
        // An image the agent sends as message content: its own item between the text runs around it.
        const image = toAgentImage(block.mimeType, block.data);
        if (image) {
          settleText();
          events.push({ type: 'item-upsert', item: { type: 'assistant-text', id: allocId('image'), text: '', images: [image], createdAt: now } });
        }
      }
      break;
    }

    case 'tool_call': {
      settleText();
      const toolCallId = String(u.toolCallId);
      const content = toolContentArray(u.content);
      const diffs = contentDiffs(content);
      const item: ToolItem = {
        type: 'tool',
        id: `tool-${next.turn}-${toolCallId}`,
        toolUseId: toolCallId,
        name: toolNameFor(u.kind, typeof u.title === 'string' ? u.title : ''),
        input: buildInput(undefined, u),
        ...(diffs.length > 0 ? { diffs } : {}),
        ...toolImages(u.content, u.rawOutput, undefined),
        createdAt: now,
      };
      // A tool_call that already reports its end state settles right away.
      if (u.status === 'completed' || u.status === 'failed') {
        applyEnd(item, u.status === 'failed', contentText(content) || rawOutputText(u.rawOutput), now);
        next = { ...next, settledTools: withSettled(next.settledTools, toolCallId, item) };
      } else {
        next = { ...next, pendingTools: { ...next.pendingTools, [toolCallId]: item } };
      }
      events.push({ type: 'item-upsert', item });
      syncSpawned(item);
      break;
    }

    case 'tool_call_update': {
      const toolCallId = String(u.toolCallId);
      const settled = next.pendingTools[toolCallId] ? undefined : next.settledTools[settledKey(toolCallId)];
      if (settled) {
        // Late update of a finished tool (possibly from an earlier turn): merge into the same card, keep it settled.
        const content = toolContentArray(u.content);
        const diffs = contentDiffs(content);
        const item: ToolItem = {
          ...settled,
          input: buildInput(settled.input, u),
          ...(diffs.length > 0 ? { diffs } : {}),
          ...toolImages(u.content, u.rawOutput, settled.images),
        };
        if (u.status === 'completed' || u.status === 'failed') {
          const text = contentText(content) || rawOutputText(u.rawOutput);
          applyEnd(item, u.status === 'failed', text || settled.result || '', settled.completedAt ?? now);
          if (u.status === 'completed') delete item.isError;
        } else {
          const text = contentText(content);
          if (text) item.result = text;
        }
        next = { ...next, settledTools: withSettled(next.settledTools, toolCallId, item) };
        events.push({ type: 'item-upsert', item });
        syncSpawned(item);
        break;
      }
      const prev = next.pendingTools[toolCallId];
      const content = toolContentArray(u.content);
      const diffs = contentDiffs(content);
      const title = typeof u.title === 'string' ? u.title : typeof prev?.input.title === 'string' ? prev.input.title : '';
      const kind = typeof u.kind === 'string' ? u.kind : (prev?.input.kind as string | undefined);
      const item: ToolItem = {
        type: 'tool',
        id: prev?.id ?? `tool-${next.turn}-${toolCallId}`,
        toolUseId: toolCallId,
        name: prev && !u.kind && !u.title ? prev.name : toolNameFor(kind as never, title),
        input: buildInput(prev?.input, u),
        ...(diffs.length > 0 ? { diffs } : prev?.diffs ? { diffs: prev.diffs } : {}),
        ...toolImages(u.content, u.rawOutput, prev?.images),
        createdAt: prev?.createdAt ?? now,
      };
      if (u.status === 'completed' || u.status === 'failed') {
        applyEnd(item, u.status === 'failed', contentText(content) || rawOutputText(u.rawOutput), now);
        const { [toolCallId]: _done, ...rest } = next.pendingTools;
        next = { ...next, pendingTools: rest, settledTools: withSettled(next.settledTools, toolCallId, item) };
      } else {
        next = { ...next, pendingTools: { ...next.pendingTools, [toolCallId]: item } };
      }
      events.push({ type: 'item-upsert', item });
      syncSpawned(item);
      break;
    }

    case 'plan':
      upsertPlan(u.entries);
      break;

    case 'plan_update':
      if (u.plan?.type === 'items') upsertPlan(u.plan.entries);
      break;

    case 'current_mode_update':
      if (typeof u.currentModeId === 'string') signals.push({ type: 'mode', currentModeId: u.currentModeId });
      break;

    case 'config_option_update':
      if (Array.isArray(u.configOptions)) signals.push({ type: 'config', configOptions: toLiteOptions(u.configOptions) });
      break;

    case 'available_commands_update':
      if (Array.isArray(u.availableCommands)) signals.push({ type: 'commands', commands: toLiteCommands(u.availableCommands) });
      break;

    case 'usage_update':
      if (typeof u.used === 'number' && typeof u.size === 'number' && u.size > 0) {
        signals.push({ type: 'context', percent: Math.max(0, Math.min(100, (u.used / u.size) * 100)) });
      }
      break;

    case 'notice': {
      const title = typeof u.title === 'string' ? cap(u.title, MAX_LABEL_CHARS) : '';
      const description = typeof u.description === 'string' && u.description ? `\n${cap(u.description, MAX_LABEL_CHARS)}` : '';
      const level = u.severity === 'error' ? 'error' : u.severity === 'warning' ? 'warn' : 'info';
      if (title || description) pushNotice(level, `${title}${description}`);
      break;
    }

    // user_message_chunk, agent_thought_chunk, plan_removed, session_info_update,
    // compaction_* and unknown updates are not rendered.
    default:
      break;
  }

  return { state: next, events, signals };
};

/** Drops `_meta` and keeps the fields AcpConfigOptionLite carries. */
function toLiteOptions(raw: unknown[]): Extract<AcpSignal, { type: 'config' }>['configOptions'] {
  const out: Extract<AcpSignal, { type: 'config' }>['configOptions'] = [];
  for (const o of raw.slice(0, MAX_LIST_ITEMS)) {
    if (!isRecord(o) || typeof o.id !== 'string' || typeof o.name !== 'string') continue;
    const base = {
      id: o.id,
      name: cap(o.name, MAX_LABEL_CHARS),
      ...(typeof o.description === 'string' ? { description: cap(o.description, MAX_LABEL_CHARS) } : {}),
      category: typeof o.category === 'string' ? o.category : null,
    };
    if (o.type === 'boolean' && typeof o.currentValue === 'boolean') {
      out.push({ ...base, type: 'boolean', currentValue: o.currentValue });
    } else if (o.type === 'select' && typeof o.currentValue === 'string') {
      out.push({ ...base, type: 'select', currentValue: o.currentValue, options: flattenSelect(o.options) });
    }
  }
  return out;
}

/** Select options may be grouped (`{group, name, options}`); the composer shows a flat list. */
function flattenSelect(
  options: unknown,
  out: { value: string; name: string; description?: string }[] = [],
): { value: string; name: string; description?: string }[] {
  if (!Array.isArray(options)) return out;
  for (const o of options) {
    if (out.length >= MAX_LIST_ITEMS) break;
    if (!isRecord(o)) continue;
    if (Array.isArray(o.options)) {
      flattenSelect(o.options, out);
    } else if (typeof o.value === 'string') {
      out.push({
        value: o.value,
        name: cap(typeof o.name === 'string' ? o.name : o.value, MAX_LABEL_CHARS),
        ...(typeof o.description === 'string' ? { description: cap(o.description, MAX_LABEL_CHARS) } : {}),
      });
    }
  }
  return out;
}

/** The settled `spawnAgent` card that started Codex agent `childId`. */
function findSpawn(state: AcpReducerState, childId: string): ToolItem | undefined {
  for (const tool of Object.values(state.settledTools)) {
    if (tool.input.title !== CODEX_SPAWN_TITLE) continue;
    const ids = tool.input.receiverThreadIds;
    if (Array.isArray(ids) && ids.includes(childId)) return tool;
  }
  return undefined;
}

function applyEnd(item: ToolItem, failed: boolean, text: string, now: number): void {
  item.result = text || (failed ? FAILED_TEXT : '');
  if (failed) item.isError = true;
  item.completedAt = now;
}

export const finalizeAcpTurn: FinalizeAcpTurnFn = (state, stopReason: StopReason | 'error', now) => {
  const events: ChatEvent[] = [];
  if (state.streamingItemId) {
    events.push({
      type: 'item-upsert',
      item: { type: 'assistant-text', id: state.streamingItemId, text: state.streamingText, createdAt: now },
    });
  }
  const aborted = stopReason === 'cancelled' || stopReason === 'error';
  let settledTools = state.settledTools;
  for (const [toolCallId, tool] of Object.entries(state.pendingTools)) {
    const settled: ToolItem = { ...tool, completedAt: now };
    if (aborted) {
      settled.isError = true;
      settled.result = INTERRUPTED_TEXT;
    } else {
      settled.result = tool.result ?? '';
    }
    settledTools = withSettled(settledTools, toolCallId, settled);
    events.push({ type: 'item-upsert', item: settled });
  }
  if (aborted) {
    // Codex agents still running when the turn was cut off: their cards stop with it.
    for (const tool of Object.values(settledTools)) {
      if (tool.input.title !== CODEX_SPAWN_TITLE || tool.taskStatus !== 'running') continue;
      const stopped: ToolItem = { ...tool, taskStatus: 'stopped', completedAt: now };
      settledTools = withSettled(settledTools, tool.toolUseId, stopped);
      events.push({ type: 'item-upsert', item: stopped });
    }
  }
  return {
    state: { ...state, streamingItemId: null, streamingMessageId: null, streamingText: '', pendingTools: {}, settledTools },
    events,
  };
};
