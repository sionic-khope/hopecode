// Local theme overlay (the `theme/` folder of the app data dir, `~/.hopecode/theme`). Main scans the folder at
// start-up and serves the files over `hopecode-theme://`; the renderer swaps a slot in only when its file exists.

/** Custom protocol that serves files of the theme folder (images and fonts only, GET only). */
export const THEME_SCHEME = 'hopecode-theme';
/** Fixed host of every theme URL: `hopecode-theme://theme/<path inside the folder>`. */
export const THEME_HOST = 'theme';

/** Extensions the protocol serves, with their content types. Anything else is refused. */
export const THEME_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/** Font slots: `fonts/<slot>.<ext>`, first existing extension wins. */
export const THEME_FONT_EXTENSIONS = ['woff2', 'woff', 'otf', 'ttf'] as const;
/** Sprite slots: `sprites/<slot>.png`. */
export const THEME_SPRITE_EXTENSIONS = ['png'] as const;

/** Largest palette.json read (bytes) and the most tokens it may set. */
export const THEME_PALETTE_MAX_BYTES = 64 * 1024;
export const THEME_PALETTE_MAX_TOKENS = 256;
/** Largest file the protocol serves (bytes). */
export const THEME_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** What the theme folder provides. Every URL is a `hopecode-theme://theme/...` URL; null = slot empty. */
export interface ThemeOverlay {
  /** Absolute theme folder (shown in the README / settings copy; never fetched by path). */
  dir: string;
  fonts: { ui: string | null; mono: string | null };
  sprites: { heart: string | null; logo: string | null };
  /** Validated CSS custom properties (`--name` -> color), or null without a usable palette.json. */
  palette: Record<string, string> | null;
}

export const EMPTY_THEME_OVERLAY: ThemeOverlay = {
  dir: '',
  fonts: { ui: null, mono: null },
  sprites: { heart: null, logo: null },
  palette: null,
};

const TOKEN_NAME_RE = /^--[a-z][a-z0-9-]{0,63}$/;
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.]+%?(?:\s*[,\s/]\s*[0-9.]+%?){2,3}\s*\)$/i;

/** A token name palette.json may set (`--accent`, or `accent` which becomes `--accent`); null when refused. */
export function normalizeTokenName(name: string): string | null {
  const full = name.startsWith('--') ? name : `--${name}`;
  return TOKEN_NAME_RE.test(full) ? full : null;
}

/** Only plain colors are accepted (hex, rgb[a](), hsl[a]()): no url(), var(), expressions or anything else. */
export function isThemeColor(value: string): boolean {
  if (value.length > 64) return false;
  const v = value.trim();
  return HEX_RE.test(v) || FUNC_RE.test(v);
}

/**
 * Parsed palette.json -> the token overrides it may apply. Accepts `{ "--accent": "#ff0000" }` or
 * `{ "tokens": { ... } }`; entries with a refused name or a non-color value are dropped. null when nothing remains.
 */
export function sanitizePalette(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const source =
    typeof obj['tokens'] === 'object' && obj['tokens'] !== null && !Array.isArray(obj['tokens'])
      ? (obj['tokens'] as Record<string, unknown>)
      : obj;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [key, value] of Object.entries(source)) {
    if (n >= THEME_PALETTE_MAX_TOKENS) break;
    if (typeof value !== 'string') continue;
    const name = normalizeTokenName(key);
    if (!name || !isThemeColor(value)) continue;
    out[name] = value.trim();
    n++;
  }
  return n > 0 ? out : null;
}

/** true for a URL the renderer may hand to CSS / FontFace / <img> (the theme scheme and host, nothing else). */
export function isThemeUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  return url.startsWith(`${THEME_SCHEME}://${THEME_HOST}/`) && !/["'()\\\s]/.test(url);
}
