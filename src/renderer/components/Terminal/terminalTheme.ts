// Token-based xterm configuration (plan 5.3 / spec: "SF Mono, 라이트 테마 xterm 색상").
// xterm renders text on <canvas>, so it needs literal color/font strings -- CSS custom properties
// (var(--x)) are not resolved there. This module is the single place that turns tokens.css values into
// the literal strings xterm needs, read from the DOM once per terminal instance (app is light-only, no
// theme switching in v1).
import type { ITheme } from '@xterm/xterm';

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Light xterm theme sourced from tokens.css. tokens.css defines --bg-terminal/--fg-terminal/
 * --cursor-terminal/--selection-terminal directly (plan 5.3); it has no separate 16-color ANSI ramp, so
 * ANSI colors reuse the status/account tokens. "white"/"bright white" are darkened relative to a typical
 * dark-theme mapping -- otherwise white-on-white text would be invisible on this light background, the
 * same swap macOS Terminal.app's light profiles make.
 */
export function resolveTerminalTheme(): ITheme {
  const background = cssVar('--bg-terminal', '#ffffff');
  const foreground = cssVar('--fg-terminal', '#1d1d1f');
  return {
    background,
    foreground,
    cursor: cssVar('--cursor-terminal', '#007aff'),
    cursorAccent: background,
    selectionBackground: cssVar('--selection-terminal', 'rgba(0, 122, 255, 0.2)'),
    black: foreground,
    red: cssVar('--crit', '#ff3b30'),
    green: cssVar('--ok', '#34c759'),
    yellow: cssVar('--warn', '#ff9500'),
    blue: cssVar('--accent', '#007aff'),
    magenta: cssVar('--account-4', '#af52de'),
    cyan: cssVar('--account-6', '#5ac8fa'),
    white: cssVar('--label-secondary', 'rgba(0, 0, 0, 0.55)'),
    brightBlack: cssVar('--label-tertiary', 'rgba(0, 0, 0, 0.3)'),
    brightRed: cssVar('--crit-text', '#d70015'),
    brightGreen: cssVar('--ok-text', '#248a3d'),
    brightYellow: cssVar('--warn-text', '#c93400'),
    brightBlue: cssVar('--accent-hover', '#0066d6'),
    brightMagenta: cssVar('--account-4', '#af52de'),
    brightCyan: cssVar('--account-6', '#5ac8fa'),
    brightWhite: cssVar('--label', 'rgba(0, 0, 0, 0.85)'),
  };
}

/** Mirrors --font-mono (a literal stack, since xterm's canvas renderer can't resolve CSS vars). */
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", "IBM Plex Sans KR", ui-monospace, "SF Mono", Menlo, monospace';
/** Mirrors --mono-term (13px). */
export const TERMINAL_FONT_SIZE = 13;
/** Mirrors --lh-mono-term / --mono-term (19/13) -- xterm's lineHeight is a unitless multiplier. */
export const TERMINAL_LINE_HEIGHT = 1.46;
