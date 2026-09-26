// Wires main -> renderer broadcast channels (plan 3.3 EventMap) into the store. Call
// `initStoreEventSubscriptions()` once after mount (Wave 3 owns the call site, e.g. `main.tsx`).
//
// `pty:data` is intentionally NOT subscribed here: it's a high-frequency raw byte stream meant
// for an xterm instance, and routing it through zustand would re-render on every chunk. Terminal
// components subscribe to it directly via `api.on('pty:data', ...)` (plan 4.4 `terminalRegistry.ts`,
// owned by lane 2B). Likewise `login:data`'s raw text could be read directly by `AddAccountDialog`,
// but it's small/low-frequency and useful to have in the store (e.g. to survive a dialog remount),
// so it's applied here.
import { on } from '../api';
import { useAppStore } from './appStore';

export function initStoreEventSubscriptions(): () => void {
  const offs = [
    on('chat:event', ({ threadId, event }) => useAppStore.getState().applyChatEvent(threadId, event)),
    on('thread:updated', (thread) => useAppStore.getState().applyThreadUpdated(thread)),
    on('permission:request', (req) => useAppStore.getState().applyPermissionRequest(req)),
    on('permission:cancel', ({ requestId }) => useAppStore.getState().applyPermissionCancel(requestId)),
    on('usage:updated', (pool) => useAppStore.getState().applyUsageUpdated(pool)),
    on('account:updated', (accounts) => useAppStore.getState().applyAccountsUpdated(accounts)),
    on('login:data', ({ loginId, data }) => useAppStore.getState().applyLoginData(loginId, data)),
    on('login:exit', ({ loginId, ok, account, error }) => useAppStore.getState().applyLoginExit(loginId, ok, account, error)),
    on('pty:exit', ({ threadId, code }) => useAppStore.getState().applyPtyExit(threadId, code)),
    on('ui:toggleTerminal', () => useAppStore.getState().toggleTerminal()),
    on('ui:toggleSidebar', () => useAppStore.getState().toggleSidebar()),
    on('ui:newThread', () => useAppStore.getState().newDraft()),
    on('ui:toggleChanges', () => useAppStore.getState().togglePanel('changes')),
    on('ui:openSettings', () => useAppStore.getState().setRoute('settings')),
    on('ui:commandPalette', () => {
      const s = useAppStore.getState();
      s.setPaletteOpen(!s.paletteOpen);
    }),
    on('settings:updated', (settings) => useAppStore.getState().applySettingsUpdated(settings)),
    on('models:updated', (models) => useAppStore.getState().applyModelsUpdated(models)),
  ];

  return () => {
    for (const off of offs) off();
  };
}
