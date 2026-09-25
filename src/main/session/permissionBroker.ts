// canUseTool <-> renderer PermissionCard bridge (plan 4.2 session/permissionBroker.ts).
// Requests are keyed by the SDK `options.requestId` (toolUseID is display-only).
// Never resolves to null (a null result permanently blocks the tool).
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { UI_PERMISSION_MODES } from '../../shared/constants';
import type { PermissionDecision, PermissionRequest, UiPermissionMode } from '../../shared/types';
import type { Broadcaster } from '../contracts';

export const PERMISSION_DENIED_MESSAGE = 'The user denied this tool use.';
export const PERMISSION_CANCELLED_MESSAGE = 'Permission request was cancelled.';

interface PendingEntry {
  request: PermissionRequest;
  suggestions: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
  cleanup: () => void;
}

export interface PermissionBroker {
  /** canUseTool callback bound to one thread (passed to Options.canUseTool). */
  canUseToolFor(threadId: string): CanUseTool;
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

  function settle(requestId: string, result: PermissionResult, broadcastCancel: boolean): void {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    entry.cleanup();
    if (broadcastCancel) deps.broadcaster.emit('permission:cancel', { requestId });
    entry.resolve(result);
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
          const onAbort = () =>
            settle(requestId, { behavior: 'deny', message: PERMISSION_CANCELLED_MESSAGE }, true);
          signal.addEventListener('abort', onAbort, { once: true });
          pending.set(requestId, {
            request,
            suggestions,
            resolve,
            cleanup: () => signal.removeEventListener('abort', onAbort),
          });
          deps.broadcaster.emit('permission:request', request);
        });
    },

    respond(requestId, decision, message) {
      const entry = pending.get(requestId);
      if (!entry) return;
      let result: PermissionResult;
      if (decision === 'allow') {
        result = { behavior: 'allow', updatedInput: entry.request.input };
      } else if (decision === 'allow-session') {
        result = { behavior: 'allow', updatedInput: entry.request.input, updatedPermissions: entry.suggestions };
      } else {
        result = { behavior: 'deny', message: message?.trim() ? message : PERMISSION_DENIED_MESSAGE };
      }
      settle(requestId, result, false);
      if (decision === 'allow-session') {
        for (const s of entry.suggestions) {
          if (s.type === 'setMode' && (UI_PERMISSION_MODES as readonly string[]).includes(s.mode)) {
            deps.onModeChange?.(entry.request.threadId, s.mode as UiPermissionMode);
          }
        }
      }
    },

    cancelThread(threadId) {
      for (const [requestId, entry] of [...pending]) {
        if (entry.request.threadId === threadId) {
          settle(requestId, { behavior: 'deny', message: PERMISSION_CANCELLED_MESSAGE }, true);
        }
      }
    },

    cancelAll() {
      for (const requestId of [...pending.keys()]) {
        settle(requestId, { behavior: 'deny', message: PERMISSION_CANCELLED_MESSAGE }, true);
      }
    },

    pending() {
      return [...pending.values()].map((e) => e.request);
    },
  };
}
