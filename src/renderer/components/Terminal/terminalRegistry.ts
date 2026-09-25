// Module-level (outside React) cache of xterm.js instances keyed by session id (thread id), so switching
// the selected thread reattaches the same terminal DOM node instead of recreating it -- scrollback,
// cursor position and the live-output subscription all survive (plan 4.4: "스레드 전환 시 인스턴스 유지
// 가능한 구조").
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface TerminalRegistryEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  /** Detached DOM node xterm renders into; TerminalPane re-parents this on mount instead of re-creating it. */
  el: HTMLDivElement;
  /** xterm's onData listener is registered once at creation and forwards through this ref, so the
   *  currently-mounted TerminalPane can swap its onData callback without re-subscribing xterm itself. */
  onDataRef: { current: (data: string) => void };
  /** True once the entry's initial replay content has been written and its live-output subscription
   *  started. Set exactly once per entry so remounting the same session never re-seeds/double-subscribes. */
  ready: boolean;
  /** Unsubscribe from the live output feed (set once, alongside `ready`); called by disposeTerminalEntry. */
  unsubscribeOutput: (() => void) | null;
}

const registry = new Map<string, TerminalRegistryEntry>();

/** Returns the existing entry for `sessionId`, or creates one (new Terminal + FitAddon, not yet attached to any DOM). */
export function getOrCreateTerminalEntry(sessionId: string, options: ITerminalOptions): TerminalRegistryEntry {
  const existing = registry.get(sessionId);
  if (existing) return existing;

  const terminal = new Terminal(options);
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const el = document.createElement('div');
  el.style.width = '100%';
  el.style.height = '100%';
  terminal.open(el);

  const onDataRef = { current: (_data: string) => {} };
  terminal.onData((data) => onDataRef.current(data));

  const entry: TerminalRegistryEntry = { terminal, fitAddon, el, onDataRef, ready: false, unsubscribeOutput: null };
  registry.set(sessionId, entry);
  return entry;
}

export function getTerminalEntry(sessionId: string): TerminalRegistryEntry | undefined {
  return registry.get(sessionId);
}

export function hasTerminalEntry(sessionId: string): boolean {
  return registry.has(sessionId);
}

/**
 * The session's shell exited (`pty:exit`): stop the live-output subscription and clear `ready`, so the next
 * TerminalPane mount re-seeds from a fresh `pty:open` (which spawns a new shell). Scrollback is kept.
 */
export function resetTerminalEntry(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.unsubscribeOutput?.();
  entry.unsubscribeOutput = null;
  entry.ready = false;
}

/** Tears down a session's terminal entirely (e.g. thread deleted / app quitting). Not called on ordinary unmount. */
export function disposeTerminalEntry(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.unsubscribeOutput?.();
  entry.terminal.dispose();
  registry.delete(sessionId);
}

/** Test/dev-only: clears every cached terminal instance. */
export function clearTerminalRegistry(): void {
  for (const id of [...registry.keys()]) disposeTerminalEntry(id);
}
