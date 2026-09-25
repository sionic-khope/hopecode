// Broadcaster: forwards allowlisted events to every open BrowserWindow (plan 3.3 event channels,
// 4.2 "Broadcaster 구현(BrowserWindow webContents.send, allowlist 이벤트만)").
// Only imports `electron` at the type level (`WebContents`), so this module has no Electron
// runtime dependency and stays trivially testable with a fake target list.
import type { WebContents } from 'electron';
import { isEventChannel } from '../../shared/ipc';
import type { Broadcaster } from '../contracts';

export interface BroadcastTarget {
  webContents: Pick<WebContents, 'send' | 'isDestroyed'>;
}

/**
 * `getTargets` is normally `() => BrowserWindow.getAllWindows()` (assembled in Wave 3); a
 * `BrowserWindow` satisfies `BroadcastTarget` structurally. The channel is re-checked against
 * the allowlist at runtime even though `Broadcaster['emit']` already restricts it at compile time,
 * since callers elsewhere in the codebase may widen the channel type (e.g. via a generic relay).
 */
export function createBroadcaster(getTargets: () => readonly BroadcastTarget[]): Broadcaster {
  return {
    emit(channel, payload) {
      if (!isEventChannel(channel)) {
        console.error(`[ipc] refused to broadcast disallowed channel: ${String(channel)}`);
        return;
      }
      for (const target of getTargets()) {
        if (target.webContents.isDestroyed()) continue;
        target.webContents.send(channel, payload);
      }
    },
  };
}
