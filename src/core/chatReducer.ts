import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ChatEvent,
  ChatImage,
  ChatReducerState,
  RateLimitInfoLite,
  RunnerSignal,
  StructuredPatchHunk,
  ToolItem,
  TurnEndReason,
} from '../shared/types';

/** SDK messages are consumed structurally; type-only import keeps core free of runtime SDK deps. */
export type SdkMessageLike = SDKMessage;

export interface ReduceResult {
  state: ChatReducerState;
  events: ChatEvent[];
  signals: RunnerSignal[];
}

/** Fresh state for one Query (output signal is emitted at most once per state). */
export function createChatReducerState(threadId: string): ChatReducerState {
  return {
    threadId,
    streamingItemId: null,
    streamingText: '',
    pendingTools: {},
    outputEmitted: false,
    seq: 0,
  };
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type?: unknown; text?: unknown } => !!block && typeof block === 'object')
      .filter((block) => block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n');
  }
  return '';
}

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Largest base64 payload kept on a chat item (10 MB decoded); bigger images are dropped. */
export const MAX_INLINE_IMAGE_BASE64 = Math.ceil((10 * 1024 * 1024 * 4) / 3);

function toChatImage(mediaType: unknown, data: unknown): ChatImage | null {
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) return null;
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_INLINE_IMAGE_BASE64) return null;
  return { mediaType: mediaType as ChatImage['mediaType'], data };
}

/**
 * Base64 image blocks of a tool_result (`{type:'image', source:{type:'base64', media_type, data}}`), falling back
 * to the Read tool's structured output (`tool_use_result: {type:'image', file:{base64, type}}`).
 */
export function extractToolResultImages(content: unknown, toolUseResult: unknown): ChatImage[] {
  const images: ChatImage[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'image') continue;
      const source = (block as { source?: Record<string, unknown> }).source;
      if (!source || source.type !== 'base64') continue;
      const image = toChatImage(source.media_type, source.data);
      if (image) images.push(image);
    }
  }
  if (images.length === 0 && toolUseResult && typeof toolUseResult === 'object') {
    const r = toolUseResult as { type?: unknown; file?: { base64?: unknown; type?: unknown } };
    if (r.type === 'image' && r.file) {
      const image = toChatImage(r.file.type, r.file.base64);
      if (image) images.push(image);
    }
  }
  return images;
}

/** `parent_tool_use_id` of an SDK message (non-empty string) or undefined for the main conversation. */
function parentOf(m: Record<string, unknown>): string | undefined {
  const parent = m.parent_tool_use_id;
  return typeof parent === 'string' && parent.length > 0 ? parent : undefined;
}

function isAsyncLaunch(toolUseResult: unknown): boolean {
  return (
    !!toolUseResult &&
    typeof toolUseResult === 'object' &&
    (toolUseResult as { status?: unknown }).status === 'async_launched'
  );
}

function extractStructuredPatch(toolUseResult: unknown): StructuredPatchHunk[] | undefined {
  if (
    toolUseResult &&
    typeof toolUseResult === 'object' &&
    Array.isArray((toolUseResult as { structuredPatch?: unknown }).structuredPatch)
  ) {
    return (toolUseResult as { structuredPatch: StructuredPatchHunk[] }).structuredPatch;
  }
  return undefined;
}

function toRateLimitInfo(raw: Record<string, unknown>): RateLimitInfoLite {
  return {
    status: raw.status as RateLimitInfoLite['status'],
    resetsAt: raw.resetsAt as number | undefined,
    rateLimitType: raw.rateLimitType as RateLimitInfoLite['rateLimitType'],
    utilization: raw.utilization as number | undefined,
    isUsingOverage: raw.isUsingOverage as boolean | undefined,
    overageInUse: raw.overageInUse as boolean | undefined,
    overageResetsAt: raw.overageResetsAt as number | undefined,
  };
}

/**
 * SDK message -> chat events + runner signals (plan 4.1). No ctx signal
 * (assistant.context_usage is ignored; ctx comes from Query.getContextUsage).
 */
export function reduceSdkMessage(state: ChatReducerState, msg: SdkMessageLike, now: number): ReduceResult {
  // The full SDK message union is large; narrow structurally at runtime instead of
  // threading the exhaustive discriminated union through this reducer.
  const m = msg as unknown as Record<string, any>;

  let next: ChatReducerState = { ...state, pendingTools: { ...state.pendingTools } };
  const events: ChatEvent[] = [];
  const signals: RunnerSignal[] = [];

  const allocId = (prefix: string): string => {
    const id = `${prefix}-${next.seq}`;
    next = { ...next, seq: next.seq + 1 };
    return id;
  };

  switch (m.type) {
    case 'stream_event': {
      const event = m.event;
      // Subagent deltas are skipped: their complete assistant messages carry the text (grouped by parent).
      if (parentOf(m)) break;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text: string = typeof event.delta.text === 'string' ? event.delta.text : '';
        let itemId = next.streamingItemId;
        if (!itemId) {
          itemId = allocId('text');
          next = { ...next, streamingItemId: itemId, streamingText: '' };
        }
        next = { ...next, streamingText: next.streamingText + text };
        events.push({ type: 'text-delta', itemId, text });
      }
      break;
    }

    case 'assistant': {
      const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
      const parent = parentOf(m);
      let sawOutput = false;

      for (const block of blocks) {
        if (block?.type === 'text') {
          const text = typeof block.text === 'string' ? block.text : '';
          if (parent) {
            // Subagent text never touches the main conversation's streaming item.
            events.push({
              type: 'item-upsert',
              item: { type: 'assistant-text', id: allocId('text'), text, createdAt: now, parentToolUseId: parent },
            });
          } else {
            const id = next.streamingItemId ?? allocId('text');
            events.push({ type: 'item-upsert', item: { type: 'assistant-text', id, text, createdAt: now } });
            next = { ...next, streamingItemId: null, streamingText: '' };
          }
          sawOutput = true;
        } else if (block?.type === 'tool_use') {
          const id = allocId('tool');
          const item: ToolItem = {
            type: 'tool',
            id,
            toolUseId: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
            createdAt: now,
            ...(parent ? { parentToolUseId: parent } : {}),
          };
          next = { ...next, pendingTools: { ...next.pendingTools, [block.id]: item } };
          events.push({ type: 'item-upsert', item });
          sawOutput = true;
        }
      }

      if (sawOutput && !next.outputEmitted) {
        next = { ...next, outputEmitted: true };
        signals.push({ type: 'output' });
      }

      if (m.error === 'rate_limit') signals.push({ type: 'rate-limit-hit' });
      if (m.error === 'authentication_failed') signals.push({ type: 'auth-failed' });
      break;
    }

    case 'user': {
      const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
      for (const block of blocks) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const toolUseId = block.tool_use_id as string;
          const pending = next.pendingTools[toolUseId];
          if (pending) {
            const result = extractToolResultText(block.content);
            const isError = block.is_error === true;
            const patch = extractStructuredPatch(m.tool_use_result);
            const images = extractToolResultImages(block.content, m.tool_use_result);
            const background = !isError && isAsyncLaunch(m.tool_use_result);
            const updated: ToolItem = {
              ...pending,
              result,
              isError,
              ...(patch ? { patch } : {}),
              ...(images.length > 0 ? { images } : {}),
              ...(background ? { taskStatus: 'running' as const } : { completedAt: now }),
            };

            const remaining = { ...next.pendingTools };
            delete remaining[toolUseId];
            next = { ...next, pendingTools: remaining };
            if (background) next = { ...next, backgroundTools: { ...next.backgroundTools, [toolUseId]: updated } };

            events.push({ type: 'item-upsert', item: updated });
          }
        }
      }
      break;
    }

    case 'system': {
      if (m.subtype === 'init') {
        signals.push({
          type: 'session-init',
          sessionId: m.session_id,
          cliVersion: typeof m.claude_code_version === 'string' ? m.claude_code_version : null,
          model: typeof m.model === 'string' ? m.model : null,
        });
      } else if (m.subtype === 'api_retry') {
        if (m.error === 'rate_limit') signals.push({ type: 'rate-limit-hit' });
      } else if (m.subtype === 'task_notification' && typeof m.tool_use_id === 'string') {
        // A background subagent settled: its launch card turns done / failed.
        const toolUseId = m.tool_use_id as string;
        const launched = next.backgroundTools?.[toolUseId];
        if (launched && (m.status === 'completed' || m.status === 'failed' || m.status === 'stopped')) {
          const updated: ToolItem = { ...launched, taskStatus: m.status, completedAt: now };
          const remaining = { ...next.backgroundTools };
          delete remaining[toolUseId];
          next = { ...next, backgroundTools: remaining };
          events.push({ type: 'item-upsert', item: updated });
        }
      }
      break;
    }

    case 'rate_limit_event': {
      const info = toRateLimitInfo(m.rate_limit_info ?? {});
      signals.push({ type: 'rate-limit', info });
      if (info.status === 'rejected') signals.push({ type: 'rate-limit-hit' });
      if (info.isUsingOverage || info.overageInUse) signals.push({ type: 'overage', info });
      break;
    }

    case 'result': {
      const isError = m.is_error === true;
      const apiErrorStatus = m.api_error_status;
      if (isError && apiErrorStatus === 429) signals.push({ type: 'rate-limit-hit' });

      const reason: TurnEndReason | undefined = isError ? (apiErrorStatus === 429 ? 'rate_limited' : 'error') : undefined;
      events.push({ type: 'turn-end', ok: !isError, reason });
      break;
    }

    default:
      break;
  }

  return { state: next, events, signals };
}
