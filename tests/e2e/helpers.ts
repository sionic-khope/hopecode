// Shared e2e harness: every launch runs in fixture mode with a temp HOPECODE_HOME, a temp git repo as the
// dialog-seam project, and no ELECTRON_RENDERER_URL (built renderer). Nothing touches ~/.hopecode,
// ~/Library/Application Support/Hopecode, the Keychain, the network or the Claude API.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');

export const SCREENSHOT_DIR =
  process.env['HOPECODE_E2E_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/e2e';

export interface Sandbox {
  home: string;
  project: string;
  cleanup(): void;
}

/** Temp HOPECODE_HOME + temp git repo with one commit (README.md "Hello world"). */
export function createSandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'hopecode-e2e-home-'));
  const project = mkdtempSync(join(tmpdir(), 'hopecode-e2e-repo-'));
  writeFileSync(join(project, 'README.md'), '# Hopecode fixture\nHello world\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Hopecode E2E', '-c', 'user.email=e2e@example.com', ...args], {
      cwd: project,
      stdio: 'ignore',
    });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return {
    home,
    project,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    },
  };
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
}

export async function launch(sandbox: Sandbox): Promise<Launched> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  }
  Object.assign(env, {
    HOPECODE_HOME: sandbox.home,
    HOPECODE_FIXTURES: '1',
    HOPECODE_FIXTURE_PROJECT: sandbox.project,
    // Headless run: main keeps the window hidden (no show/focus, no Dock/menu bar) and never opens native dialogs.
    HOPECODE_E2E: '1',
  });
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  hardenClose(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('statusline')).toBeVisible();
  // Bootstrap + first usage poll done: the fixture pool reports 3 accounts.
  await expect(page.getByTestId('statusline')).toContainText('/3 avail');
  return { app, page };
}

/** How long `app.close()` may wait for the Electron process to exit before it is killed. */
const CLOSE_GRACE_MS = 10_000;

/**
 * Electron 44 under Playwright's `--inspect` loader sometimes never finishes its native teardown on macOS: the app
 * quits normally (before-quit dispose flushes state, `will-quit` / `quit` / Node `exit` all fire), then the process
 * sits waiting for the inspector to disconnect while Playwright waits for the process to exit. It reproduces on the
 * pre-v5 build too, so it is not app behavior. `app.close()` keeps its normal path and only kills the process if it
 * is still alive after a grace period long enough for the dispose (<5s by QUIT_DISPOSE_TIMEOUT_MS) to have finished.
 */
function hardenClose(app: ElectronApplication): void {
  const close = app.close.bind(app);
  app.close = async () => {
    const proc = app.process();
    const closing = close().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CLOSE_GRACE_MS);
    });
    const result = await Promise.race([closing.then(() => 'closed' as const), graceOver]);
    clearTimeout(timer);
    if (result === 'timeout') {
      const exited =
        proc.exitCode !== null || proc.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      proc.kill('SIGKILL');
      // Playwright's own close() may stay pending once the process is gone; the exit of the process is what counts.
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  };
}

export async function screenshot(page: Page, name: string, dir: string = SCREENSHOT_DIR): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // Let finite enter animations (popover fade/scale) settle so the capture shows the resting state.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().iterations ?? Infinity))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** Opens a new chat (draft) from the sidebar's "새 채팅" entry. */
export async function openDraft(page: Page): Promise<void> {
  await page.getByTestId('sidebar').getByRole('button', { name: /^새 채팅/ }).click();
  await expect(page.getByTestId('draft')).toBeVisible();
}

/** Sidebar nav 더보기 (⋯) -> `label` (계정, 사용량, 설정, 키보드 단축키, 앱 정보, 보관된 스레드). */
export async function openFromMore(page: Page, label: string): Promise<void> {
  await page.getByTestId('sidebar-nav').getByRole('button', { name: '더보기' }).click();
  await page.getByRole('menu', { name: '탐색 더보기' }).getByRole('menuitem', { name: new RegExp(`^${label}`) }).click();
}

/**
 * Draft folder chip -> "다른 폴더 선택…" (the dialog seam answers HOPECODE_FIXTURE_PROJECT and trusts it). No-op
 * when the draft already points at a folder.
 */
export async function chooseFixtureFolder(page: Page, sandbox: Sandbox): Promise<void> {
  const draft = page.getByTestId('draft');
  const name = sandbox.project.split('/').pop()!;
  const chip = draft.locator('.hc-chip--folder');
  if ((await chip.textContent())?.includes(name)) return;
  await chip.click();
  await page.getByRole('menuitem', { name: '다른 폴더 선택…' }).click();
  await expect(chip).toContainText(name);
}

/**
 * New chat in the fixture folder: ⌘N-equivalent draft, folder chip, first message. The thread (and its worktree)
 * exists only after this send (thread:start).
 */
export async function startThread(page: Page, sandbox: Sandbox, text: string): Promise<void> {
  await openDraft(page);
  await chooseFixtureFolder(page, sandbox);
  const before = await page.getByTestId('sidebar').locator('.hc-thread').count();
  await sendMessage(page, text);
  await expect(page.getByTestId('sidebar').locator('.hc-thread')).toHaveCount(before + 1);
  await expect(page.locator('.hc-messages .hc-msg-user__bubble').last()).toHaveText(text);
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  const box = page.locator('.hc-composer__textarea');
  await box.fill(text);
  await box.press('Enter');
}

/** Threads as main sees them (via the preload bridge). */
export interface ThreadState {
  id: string;
  cwd: string;
  title: string;
  projectId: string;
  pinned: boolean;
  archived: boolean;
  effort: string | null;
  permissionMode: string;
  sdkSessionId: string | null;
  worktree?: { path: string; branch: string };
}

export async function bootstrapState(
  page: Page,
): Promise<{ threads: ThreadState[]; projects: { id: string; path: string; trusted: boolean }[] }> {
  return page.evaluate(() => window.hopecode.invoke('app:bootstrap')) as never;
}

/**
 * ⌘J / ⌘N / ⌘B live only in the app menu (the renderer has no keydown handler, so a shortcut runs once).
 * Playwright's synthetic key events never reach native menu accelerators, so specs click the menu item that
 * owns the accelerator — the same code path a real keypress takes.
 */
export async function menuShortcut(
  app: ElectronApplication,
  accelerator:
    | 'CmdOrCtrl+J'
    | 'CmdOrCtrl+N'
    | 'CmdOrCtrl+B'
    | 'CmdOrCtrl+K'
    | 'CmdOrCtrl+,'
    | 'CmdOrCtrl+Shift+D'
    | 'CmdOrCtrl+Shift+N',
): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, acc) => {
    type Item = { accelerator?: string | null; submenu?: { items: Item[] } | null; click: (...args: unknown[]) => void };
    const find = (items: Item[]): Item | undefined => {
      for (const item of items) {
        if (item.accelerator === acc) return item;
        const nested = item.submenu ? find(item.submenu.items) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    const item = find((Menu.getApplicationMenu()?.items ?? []) as unknown as Item[]);
    if (!item) throw new Error(`no menu item with accelerator ${acc}`);
    item.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
  }, accelerator);
}

/** Screenshot of one element (settled animations), for component-level captures. */
export async function screenshotOf(
  page: Page,
  locator: ReturnType<Page['locator']>,
  name: string,
  dir: string = SCREENSHOT_DIR,
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().iterations ?? Infinity))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await locator.screenshot({ path: join(dir, `${name}.png`) });
}
