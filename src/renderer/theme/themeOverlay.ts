// Local theme overlay on the renderer side: asks main which slots of ~/.hopecode/theme hold a file and swaps each one
// in -- palette.json tokens on :root, fonts/ui.* and fonts/mono.* as FontFaces in front of the font stacks,
// sprites/heart.png as --sprite-heart (list cursor + send button), sprites/logo.png in place of the brand mark.
// Empty slots keep the bundled originals; any failure leaves the bundled theme untouched.
import { useSyncExternalStore } from 'react';
import { EMPTY_THEME_OVERLAY, isThemeColor, isThemeUrl, normalizeTokenName, type ThemeOverlay } from '../../shared/theme';
import { invoke } from '../api';

const UI_FAMILY = 'Hopecode Overlay UI';
const MONO_FAMILY = 'Hopecode Overlay Mono';

let current: ThemeOverlay = EMPTY_THEME_OVERLAY;
const listeners = new Set<() => void>();

function publish(next: ThemeOverlay): void {
  current = next;
  for (const l of listeners) l();
}

/** The applied overlay (BrandMark reads the logo slot). */
export function useThemeOverlay(): ThemeOverlay {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** Only theme-scheme URLs and plain colors ever reach CSS, even though main already validated them. */
function sanitize(raw: ThemeOverlay): ThemeOverlay {
  const url = (u: unknown): string | null => (isThemeUrl(u) ? u : null);
  let palette: Record<string, string> | null = null;
  if (raw.palette && typeof raw.palette === 'object') {
    const entries = Object.entries(raw.palette).flatMap(([k, v]) => {
      const name = normalizeTokenName(k);
      return name && typeof v === 'string' && isThemeColor(v) ? [[name, v.trim()] as const] : [];
    });
    palette = entries.length > 0 ? Object.fromEntries(entries) : null;
  }
  return {
    dir: typeof raw.dir === 'string' ? raw.dir : '',
    fonts: { ui: url(raw.fonts?.ui), mono: url(raw.fonts?.mono) },
    sprites: { heart: url(raw.sprites?.heart), logo: url(raw.sprites?.logo) },
    palette,
  };
}

async function addFont(family: string, url: string): Promise<boolean> {
  try {
    const face = new FontFace(family, `url("${url}")`, { display: 'block' });
    await face.load();
    document.fonts.add(face);
    return true;
  } catch (err) {
    console.warn(`[theme] font overlay ${url} failed`, err);
    return false;
  }
}

/** Puts `family` in front of the stack held by `token` (computed from tokens.css / palette). */
function prependFamily(root: HTMLElement, token: string, family: string): void {
  const stack = getComputedStyle(root).getPropertyValue(token).trim();
  root.style.setProperty(token, stack ? `'${family}', ${stack}` : `'${family}'`);
}

/**
 * Fetches and applies the overlay. Resolves once fonts are loaded (so xterm measures the overlay mono face) and never
 * rejects. `data-theme-overlay` on <html> lists the applied slots (diagnostics, e2e).
 */
export async function applyThemeOverlay(): Promise<ThemeOverlay> {
  let overlay: ThemeOverlay;
  try {
    overlay = sanitize(await invoke('theme:overlay'));
  } catch (err) {
    console.warn('[theme] overlay unavailable', err);
    return current;
  }
  const root = document.documentElement;
  const applied: string[] = [];
  if (overlay.palette) {
    for (const [name, value] of Object.entries(overlay.palette)) root.style.setProperty(name, value);
    applied.push('palette');
  }
  const [ui, mono] = await Promise.all([
    overlay.fonts.ui ? addFont(UI_FAMILY, overlay.fonts.ui) : Promise.resolve(false),
    overlay.fonts.mono ? addFont(MONO_FAMILY, overlay.fonts.mono) : Promise.resolve(false),
  ]);
  if (ui) {
    // Every text face but the HOPECODE wordmark: UI, conversation, titles.
    for (const token of ['--font-ui', '--font-chat', '--font-display']) prependFamily(root, token, UI_FAMILY);
    applied.push('ui');
  }
  if (mono) {
    prependFamily(root, '--font-mono', MONO_FAMILY);
    applied.push('mono');
  }
  if (overlay.sprites.heart) {
    root.style.setProperty('--sprite-heart', `url("${overlay.sprites.heart}")`);
    applied.push('heart');
  }
  if (overlay.sprites.logo) applied.push('logo');
  if (applied.length > 0) root.dataset.themeOverlay = applied.join(' ');
  publish({
    ...overlay,
    fonts: { ui: ui ? overlay.fonts.ui : null, mono: mono ? overlay.fonts.mono : null },
  });
  return current;
}
