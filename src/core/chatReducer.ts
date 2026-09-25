import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ChatEvent,
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
      let sawOutput = false;

      for (const block of blocks) {
        if (block?.type === 'text') {
          const id = next.streamingItemId ?? allocId('text');
          events.push({
            type: 'item-upsert',
            item: { type: 'assistant-text', id, text: typeof block.text === 'string' ? block.text : '', createdAt: now },
          });
          next = { ...next, streamingItemId: null, streamingText: '' };
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
            const updated: ToolItem = { ...pending, result, isError, ...(patch ? { patch } : {}) };

            const remaining = { ...next.pendingTools };
            delete remaining[toolUseId];
            next = { ...next, pendingTools: remaining };

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
