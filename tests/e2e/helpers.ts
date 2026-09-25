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
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('statusline')).toBeVisible();
  // Bootstrap + first usage poll done: the fixture pool reports 3 accounts.
  await expect(page.getByTestId('statusline')).toContainText('/3 avail');
  return { app, page };
}

export async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
}

/** Add the fixture project (dialog seam) and create a thread in it. */
export async function addProjectAndThread(page: Page): Promise<void> {
  const sidebar = page.getByTestId('sidebar');
  if ((await sidebar.locator('.hc-project').count()) === 0) {
    await sidebar.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect(sidebar.locator('.hc-project')).toHaveCount(1);
  }
  const before = await sidebar.locator('.hc-thread').count();
  await sidebar.getByRole('button', { name: 'New thread', exact: true }).click();
  await expect(sidebar.locator('.hc-thread')).toHaveCount(before + 1);
  await expect(page.locator('.hc-composer__textarea')).toBeVisible();
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  const box = page.locator('.hc-composer__textarea');
  await box.fill(text);
  await box.press('Enter');
}

/** Threads as main sees them (via the preload bridge). */
export async function bootstrapState(page: Page): Promise<{ threads: { id: string; cwd: string; title: string }[] }> {
  return page.evaluate(() => window.hopecode.invoke('app:bootstrap')) as never;
}

/**
 * ⌘J / ⌘N live only in the app menu (the renderer has no keydown handler, so a shortcut runs once).
 * Playwright's synthetic key events never reach native menu accelerators, so specs click the menu item that
 * owns the accelerator — the same code path a real keypress takes.
 */
export async function menuShortcut(app: ElectronApplication, accelerator: 'CmdOrCtrl+J' | 'CmdOrCtrl+N'): Promise<void> {
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
