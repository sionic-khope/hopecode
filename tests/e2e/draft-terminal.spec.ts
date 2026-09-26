// H1: the terminal must open before any thread exists (draft screen, ⌘J) -- reported as "터미널이 안 열린다".
// The draft's pty session (DRAFT_PTY_SESSION_ID) starts in the user's home folder, and reopens in the
// draft's selected project folder once one is picked.
import { homedir } from 'node:os';
import { expect, test } from '@playwright/test';
import {
  chooseFixtureFolder,
  createSandbox,
  launch,
  menuShortcut,
  screenshot,
  type Launched,
  type Sandbox,
} from './helpers';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

async function pwdOutput(page: Launched['page']) {
  const rows = page.getByTestId('terminal').locator('.xterm-rows');
  return ((await rows.textContent()) ?? '').replace(/\s+/g, '');
}

test('⌘J on the empty draft (0 threads) opens the terminal in the home folder', async () => {
  const { page } = run;
  // Fresh sandbox: no threads yet, so the app opens straight into the draft ("새 채팅") screen.
  await expect(page.getByTestId('draft')).toBeVisible();
  const app = page.locator('.app');
  await expect(app).toHaveClass(/app--terminal-closed/);

  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(app).toHaveClass(/app--terminal-open/);
  const term = page.getByTestId('terminal').locator('.xterm');
  await expect(term).toBeVisible();

  await term.click();
  await page.keyboard.type('echo "CWD=[$(pwd -P)]"\n');
  // macOS tmpdir/home can be a /var -> /private/var symlink; compare on the tail after the real homedir.
  const home = homedir();
  await expect.poll(() => pwdOutput(page), { timeout: 20_000 }).toContain(`CWD=[${home}]`);
  await screenshot(page, 'draft-terminal-home');
});

test('changing the draft folder chip reopens the terminal in that folder', async () => {
  const { page } = run;
  await expect(page.getByTestId('terminal').locator('.xterm')).toBeVisible();

  await chooseFixtureFolder(page, sandbox);

  const term = page.getByTestId('terminal').locator('.xterm');
  await expect(term).toBeVisible();
  await term.click();
  await page.keyboard.type('echo "CWD=[$(pwd -P)]"\n');
  // macOS tmpdir is a /var -> /private/var symlink; compare on the folder-relative tail (see chat.spec.ts).
  const tail = sandbox.project.split('/').pop()!;
  await expect.poll(() => pwdOutput(page), { timeout: 20_000 }).toContain(`${tail}]`);
  await screenshot(page, 'draft-terminal-folder');
});
