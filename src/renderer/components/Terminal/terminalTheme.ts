// Token-based xterm configuration (plan 5.3). xterm renders text on <canvas>, so it needs literal color/font strings --
// CSS custom properties (var(--x)) are not resolved there. This module is the single place that turns tokens.css
// values into the literal strings xterm needs, read from the DOM once per terminal instance (dark only, no theme
// switching; a palette.json overlay is applied before the first terminal opens).
import type { ITheme } from '@xterm/xterm';

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Dark xterm theme sourced from tokens.css: black canvas, white text, the yellow block cursor and the --ansi-* ramp
 * (violet blue, cyan, the soul red ...). Fallbacks repeat the token values for a DOM without tokens.css.
 */
export function resolveTerminalTheme(): ITheme {
  const background = cssVar('--bg-terminal', '#000000');
  const foreground = cssVar('--fg-terminal', '#ffffff');
  return {
    background,
    foreground,
    cursor: cssVar('--cursor-terminal', '#ffe14d'),
    cursorAccent: background,
    selectionBackground: cssVar('--selection-terminal', 'rgba(155, 77, 255, 0.4)'),
    black: cssVar('--ansi-black', '#000000'),
    red: cssVar('--ansi-red', '#ff3b4e'),
    green: cssVar('--ansi-green', '#3ce07a'),
    yellow: cssVar('--ansi-yellow', '#ffe14d'),
    blue: cssVar('--ansi-blue', '#9b4dff'),
    magenta: cssVar('--ansi-magenta', '#ff6bd5'),
    cyan: cssVar('--ansi-cyan', '#4fe3f0'),
    white: cssVar('--ansi-white', '#b8b0cc'),
    brightBlack: cssVar('--ansi-bright-black', '#6e6685'),
    brightRed: cssVar('--ansi-bright-red', '#ff6b79'),
    brightGreen: cssVar('--ansi-bright-green', '#5cf097'),
    brightYellow: cssVar('--ansi-bright-yellow', '#fff08a'),
    brightBlue: cssVar('--ansi-bright-blue', '#b077ff'),
    brightMagenta: cssVar('--ansi-bright-magenta', '#ff9ae3'),
    brightCyan: cssVar('--ansi-bright-cyan', '#8ff0f7'),
    brightWhite: cssVar('--ansi-bright-white', '#ffffff'),
  };
}

/** Literal mirror of --font-mono (xterm's canvas renderer can't resolve CSS vars). */
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", "Galmuri11", ui-monospace, "SF Mono", Menlo, monospace';

/** --font-mono as resolved now (a mono.* overlay font is prepended there), or the literal mirror. */
export function resolveTerminalFontFamily(): string {
  return cssVar('--font-mono', TERMINAL_FONT_FAMILY);
}

/** Mirrors --mono-term (13px). */
export const TERMINAL_FONT_SIZE = 13;
/** Mirrors --lh-mono-term / --mono-term (19/13) -- xterm's lineHeight is a unitless multiplier. */
export const TERMINAL_LINE_HEIGHT = 1.46;
