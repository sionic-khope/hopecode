// Agent permission requests <-> renderer PermissionCard bridge (plan 4.2 session/permissionBroker.ts, 2.5).
// Claude: SDK canUseTool, keyed by `options.requestId` (toolUseID is display-only).
// ACP (Codex / Hermes): `session/request_permission`, keyed by `acp-<uuid>`, answered with one of the agent's options.
// Never resolves to null / never hangs (a null result permanently blocks the tool).
import { randomUUID } from 'node:crypto';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { pickOption, pickSessionOption } from '../../core/acpPermission';
import { toolNameFor } from '../../core/acpReducer';
import type { AcpAgentKind } from '../../core/acpTypes';
import { UI_PERMISSION_MODES } from '../../shared/constants';
import type { AcpPermissionOptionLite, PermissionDecision, PermissionRequest, UiPermissionMode } from '../../shared/types';
import type { Broadcaster } from '../contracts';

export const PERMISSION_DENIED_MESSAGE = 'The user denied this tool use.';
export const PERMISSION_CANCELLED_MESSAGE = 'Permission request was cancelled.';

/** Upper bound of the JSON size of an ACP tool's rawInput shown on the card (plan 2.5). */
const ACP_INPUT_MAX_BYTES = 8 * 1024;
const PREVIEW_HEAD_CHARS = 6 * 1024;
const PREVIEW_TAIL_CHARS = 2 * 1024;

interface PendingEntry {
  request: PermissionRequest;
  /** Claude only: suggestions applied by `allow-session`. */
  suggestions: PermissionUpdate[];
  /** Agent-neutral answer: a decision from the card, or `cancelled` (abort / Stop / thread close / quit). */
  resolve: (decision: PermissionDecision | 'cancelled', message?: string) => void;
  cleanup: () => void;
}

export interface PermissionBroker {
  /** canUseTool callback bound to one thread (passed to Options.canUseTool). */
  canUseToolFor(threadId: string): CanUseTool;
  /**
   * ACP `session/request_permission` of one thread. Resolves with the agent option the decision maps to
   * (core/acpPermission.pickOption), or `cancelled` on abort / cancelThread / cancelAll / an unmapped decision.
   */
  requestAcp(
    threadId: string,
    agent: AcpAgentKind,
    req: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  respond(requestId: string, decision: PermissionDecision, message?: string): void;
  /** Deny + `permission:cancel` every pending request of the thread (Query close). */
  cancelThread(threadId: string): void;
  /** Deny + cancel everything (app quit). */
  cancelAll(): void;
  pending(): PermissionRequest[];
}

/**
 * `allow-session` must never persist rules to settings files: every suggestion is forced to
 * destination 'session' (userSettings would write through the ~/.claude symlink; critic N1).
 * A `setMode` to bypassPermissions is dropped: that mode is only entered through the confirmed UI switch (L8).
 */
export function toSessionPermissions(suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (suggestions ?? [])
    .filter((s) => !(s.type === 'setMode' && s.mode === 'bypassPermissions'))
    .map((s) => ({ ...s, destination: 'session' as const }));
}

export interface PermissionBrokerDeps {
  broadcaster: Broadcaster;
  /** An accepted `allow-session` changed the session's permission mode (store must follow the CLI). */
  onModeChange?: (threadId: string, mode: UiPermissionMode) => void;
}

export function createPermissionBroker(deps: PermissionBrokerDeps): PermissionBroker {
  const pending = new Map<string, PendingEntry>();

  function settle(
    requestId: string,
    decision: PermissionDecision | 'cancelled',
    broadcastCancel: boolean,
    message?: string,
  ): PendingEntry | undefined {
    const entry = pending.get(requestId);
    if (!entry) return undefined;
    pending.delete(requestId);
    entry.cleanup();
    if (broadcastCancel) deps.broadcaster.emit('permission:cancel', { requestId });
    entry.resolve(decision, message);
    return entry;
  }

  /** Registers a pending request, wires its abort signal (-> cancelled) and shows the card. */
  function add(entry: Omit<PendingEntry, 'cleanup'>, signal: AbortSignal): void {
    const { requestId } = entry.request;
    const onAbort = () => settle(requestId, 'cancelled', true);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.set(requestId, { ...entry, cleanup: () => signal.removeEventListener('abort', onAbort) });
    deps.broadcaster.emit('permission:request', entry.request);
  }

  return {
    canUseToolFor(threadId) {
      return (toolName, input, options) =>
        new Promise<PermissionResult>((resolve) => {
          const { requestId, signal } = options;
          if (signal.aborted) {
            resolve({ behavior: 'deny', message: PERMISSION_CANCELLED_MESSAGE });
            return;
          }
          const suggestions = toSessionPermissions(options.suggestions);
          const request: PermissionRequest = {
            requestId,
            threadId,
            toolUseId: options.toolUseID,
            toolName,
            input,
            title: options.title,
            description: options.description,
            displayName: options.displayName,
            hasSessionSuggestion: suggestions.length > 0 && options.suppressAlwaysAllowRule !== true,
            defaultToNo: options.defaultToNo,
          };
          add(
            {
              request,
              suggestions,
              resolve: (decision, message) => {
                if (decision === 'allow') resolve({ behavior: 'allow', updatedInput: input });
                else if (decision === 'allow-session') {
                  resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: suggestions });
                } else if (decision === 'deny') {
                  resolve({ behavior: 'deny', message: message?.trim() ? message : PERMISSION_DENIED_MESSAGE });
                } else resolve({ behavior: 'deny', message: PERMISSION_CANCELLED_MESSAGE });
              },
            },
            signal,
          );
        });
    },

    requestAcp(threadId, agent, req, signal) {
      return new Promise<RequestPermissionResponse>((resolve) => {
        const options = req.options.map(
          (o): AcpPermissionOptionLite => ({ optionId: o.optionId, name: o.name, kind: o.kind }),
        );
        if (signal.aborted) {
          resolve({ outcome: { outcome: 'cancelled' } });
          return;
        }
        const tool = req.toolCall;
        const title = tool.title ?? '';
        const sessionOption = pickSessionOption(options);
        const request: PermissionRequest = {
          requestId: `acp-${randomUUID()}`,
          threadId,
          toolUseId: tool.toolCallId,
          toolName: toolNameFor(tool.kind, title, agent),
          input: acpToolInput(title, tool.rawInput),
          title: title || undefined,
          hasSessionSuggestion: sessionOption !== null,
          agent,
          agentOptions: options,
          ...(sessionOption ? { sessionLabel: sessionOption.name } : {}),
        };
        add(
          {
            request,
            suggestions: [],
            resolve: (decision) => {
              const pick = decision === 'cancelled' ? null : pickOption(decision, options);
              resolve({ outcome: pick ?? { outcome: 'cancelled' } });
            },
          },
          signal,
        );
      });
    },

    respond(requestId, decision, message) {
      const entry = settle(requestId, decision, false, message);
      if (!entry || decision !== 'allow-session') return;
      for (const s of entry.suggestions) {
        if (s.type === 'setMode' && (UI_PERMISSION_MODES as readonly string[]).includes(s.mode)) {
          deps.onModeChange?.(entry.request.threadId, s.mode as UiPermissionMode);
        }
      }
    },

    cancelThread(threadId) {
      for (const [requestId, entry] of [...pending]) {
        if (entry.request.threadId === threadId) {
          settle(requestId, 'cancelled', true);
        }
      }
    },

    cancelAll() {
      for (const requestId of [...pending.keys()]) {
        settle(requestId, 'cancelled', true);
      }
    },

    pending() {
      return [...pending.values()].map((e) => e.request);
    },
  };
}

/** Card input of an ACP tool: the title plus the agent's rawInput when it is a small JSON object. */
function acpToolInput(title: string, rawInput: unknown): Record<string, unknown> {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    let json: string | null = null;
    try {
      json = JSON.stringify(rawInput);
    } catch {
      // Not serializable: show the title only.
    }
    // `title` last: the agent's rawInput never overrides what the card is titled.
    if (json !== null && json.length <= ACP_INPUT_MAX_BYTES) return { ...(rawInput as Record<string, unknown>), title };
    if (json !== null) {
      const command = (rawInput as Record<string, unknown>).command;
      const text = typeof command === 'string' ? command : json;
      // Head and tail: the end of a long command (often where it does the damage) stays visible.
      const preview =
        text.length > ACP_INPUT_MAX_BYTES
          ? `${text.slice(0, PREVIEW_HEAD_CHARS)}\n… (truncated) …\n${text.slice(-PREVIEW_TAIL_CHARS)}`
          : `${text}\n… (truncated)`;
      return { preview, truncated: true, title };
    }
  }
  return { title };
}
