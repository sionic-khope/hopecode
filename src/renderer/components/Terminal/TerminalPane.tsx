import { useLayoutEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { getOrCreateTerminalEntry } from './terminalRegistry';
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT, resolveTerminalTheme } from './terminalTheme';
import './Terminal.css';

export interface TerminalPaneProps {
  /** Stable id for the underlying pty session -- the thread id. Switching this reattaches (or creates)
   *  that session's cached terminal instance instead of recreating the current one. */
  sessionId: string;
  /** Called with every chunk of user input (keystrokes, paste, ⌘V, etc.) to forward to `pty:write`. */
  onData: (data: string) => void;
  /**
   * Subscribes to live output for `sessionId` (the `pty:data` event stream). Called once per session,
   * the very first time that session's terminal is created -- not on every TerminalPane mount -- so the
   * subscription (and therefore incoming output) survives the pane being unmounted while the terminal
   * sidebar is closed or another thread is selected. Must return an unsubscribe function.
   */
  subscribeOutput: (sessionId: string, onChunk: (data: string) => void) => () => void;
  /**
   * Replay/backfill content to seed a brand-new terminal instance with (e.g. `pty:open`'s `replay` ring
   * buffer, or `chat:history`-equivalent for the shell). Called once per session, before subscribing to
   * live output. Skipped entirely on later remounts of an already-created session.
   */
  getInitialContent?: (sessionId: string) => string | Promise<string>;
  /** Reported after every fit (initial layout and on resize) so the caller can send `pty:resize`. */
  onResize?: (cols: number, rows: number) => void;
  className?: string;
}

/**
 * xterm.js terminal bound to one thread's pty session (plan 4.4). Data in/out is entirely prop-driven
 * (onData / subscribeOutput) -- this component never touches IPC directly, matching the rest of Wave 2B's
 * props-only components (store wiring happens in Wave 3). The actual Terminal instance lives in
 * terminalRegistry.ts, keyed by sessionId, so switching threads reattaches state instead of recreating it.
 */
export function TerminalPane({ sessionId, onData, subscribeOutput, getInitialContent, onResize, className }: TerminalPaneProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Keep the latest onData without re-running the attach effect on every render.
  const onDataLatest = useRef(onData);
  onDataLatest.current = onData;

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;

    const entry = getOrCreateTerminalEntry(sessionId, {
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      theme: resolveTerminalTheme(),
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: false,
    });

    wrapper.appendChild(entry.el);
    entry.onDataRef.current = (data) => onDataLatest.current(data);
    entry.terminal.focus();

    // Seed + subscribe exactly once per session (see terminalRegistry.ts doc comment on `ready`).
    if (!entry.ready) {
      entry.ready = true;
      void (async () => {
        const initial = await getInitialContent?.(sessionId);
        if (initial) entry.terminal.write(initial);
        entry.unsubscribeOutput = subscribeOutput(sessionId, (chunk) => entry.terminal.write(chunk));
      })();
    }

    let raf = 0;
    const fit = () => {
      try {
        entry.fitAddon.fit();
        onResize?.(entry.terminal.cols, entry.terminal.rows);
      } catch {
        // Container not laid out yet (zero size); the next ResizeObserver tick will retry.
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    resizeObserver.observe(wrapper);
    raf = requestAnimationFrame(fit);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      entry.onDataRef.current = () => {};
      if (wrapper.contains(entry.el)) wrapper.removeChild(entry.el);
      // Intentionally no dispose/unsubscribe here: the terminal instance and its live-output
      // subscription outlive this component (see terminalRegistry.ts).
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onData is read via onDataLatest, not a dep.
  }, [sessionId, subscribeOutput, getInitialContent, onResize]);

  return <div ref={wrapperRef} className={['hc-terminal', className ?? ''].filter(Boolean).join(' ')} />;
}
