// Theme wiring on the Electron side: the dark native theme, the privileged `hopecode-theme://` scheme serving the
// local theme folder (`hopecodeHome()/theme`), and the overlay scan the renderer asks for over `theme:overlay`.
// File access rules (containment, extensions, size) live in themeFiles.ts; this file only adapts them to Electron.
import { readFile } from 'node:fs/promises';
import { app, nativeTheme, protocol } from 'electron';
import { THEME_SCHEME, type ThemeOverlay } from '../../shared/theme';
import { hopecodeHome } from '../paths';
import { resolveThemeRequest, scanThemeOverlay, themeDirOf } from './themeFiles';

/** The theme folder (`~/.hopecode/theme`, or `$HOPECODE_HOME/home/theme` in dev / e2e). */
export function themeDir(): string {
  return themeDirOf(hopecodeHome());
}

function refuse(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

/** Handler of one `hopecode-theme://` request (GET, inside the folder, image / font only). */
export async function serveThemeRequest(dir: string, request: Request): Promise<Response> {
  const hit = await resolveThemeRequest(dir, request.method, request.url);
  if (!hit.ok) return refuse(hit.status);
  try {
    const body = await readFile(hit.path);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': hit.mime,
        'content-length': String(body.byteLength),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        // FontFace loads are CORS requests; the page origin is file:// (null) or the dev server.
        'access-control-allow-origin': '*',
      },
    });
  } catch {
    return refuse(404);
  }
}

/**
 * Must run before `app.ready`: dark native theme (menus, traffic-light area, scrollbars), the scheme's privileges
 * (standard + secure so fonts and images load under the CSP, CORS for FontFace), and the handler once the app is
 * ready. The handler reads the folder per request, so files dropped in later are picked up on the next load.
 */
export function setupTheme(): void {
  nativeTheme.themeSource = 'dark';
  protocol.registerSchemesAsPrivileged([
    {
      scheme: THEME_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: false },
    },
  ]);
  void app.whenReady().then(() => {
    protocol.handle(THEME_SCHEME, (request) => serveThemeRequest(themeDir(), request));
  });
}

/** `theme:overlay`: the slots of the theme folder that hold a file right now. */
export function themeOverlay(): Promise<ThemeOverlay> {
  return scanThemeOverlay(themeDir());
}
