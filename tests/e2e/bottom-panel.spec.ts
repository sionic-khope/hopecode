// v6: roles split like Codex -- the bottom-panel icon / ⌘J docks the terminal under the conversation (inside the
// chat column), the right-panel icon / ⌘⇧D shows 변경사항 only. Both can be open at once; the terminal's height is
// dragged from its top edge and persists across restarts.
import { expect, test, type Page } from '@playwright/test';
import {
  bottomTerminal,
  createSandbox,
  launch,
  menuShortcut,
  openDraft,
  screenshot,
  startThread,
  type Launched,
  type Sandbox,
} from './helpers';

test.describe.configure({ mode: 'serial' });

const SHOTS =
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

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

const toolbar = (page: Page) => page.getByRole('toolbar', { name: '스레드 도구' });
const bottomToggle = (page: Page) => toolbar(page).getByRole('button', { name: '하단 터미널' });
const rightToggle = (page: Page) => toolbar(page).getByRole('button', { name: '변경사항 패널' });

async function box(page: Page, locator: ReturnType<Page['locator']>) {
  // Wait for the open/close slide to settle before measuring.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().iterations ?? Infinity))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

test('draft: the bottom-panel icon opens the terminal under the composer, inside the chat column', async () => {
  const { page } = run;
  await openDraft(page);
  const app = page.locator('.app');
  await expect(app).toHaveClass(/app--terminal-closed/);
  await bottomToggle(page).click();
  await expect(app).toHaveClass(/app--terminal-open/);
  await expect(bottomToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(rightToggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(app).toHaveClass(/app--panel-closed/);

  const panel = page.getByTestId('bottom-panel');
  await expect(bottomTerminal(page).locator('.xterm')).toBeVisible();
  await expect(panel.locator('.hc-bottom__title')).toHaveText('터미널');
  await expect(panel.getByTestId('terminal-cwd')).toHaveText('~');
  await expect(panel.getByRole('button', { name: '터미널 재시작' })).toBeVisible();

  const composer = await box(page, page.locator('.hc-composer'));
  const terminal = await box(page, bottomTerminal(page));
  const chat = await box(page, page.getByTestId('chat'));
  expect(terminal.y).toBeGreaterThanOrEqual(composer.y + composer.height - 1);
  expect(terminal.x).toBeGreaterThanOrEqual(chat.x - 1);
  expect(terminal.x + terminal.width).toBeLessThanOrEqual(chat.x + chat.width + 1);

  // Header close button closes it again.
  await panel.getByRole('button', { name: '터미널 닫기' }).click();
  await expect(app).toHaveClass(/app--terminal-closed/);
  await expect(bottomToggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('thread: the right-panel icon shows 변경사항 only, with no terminal tab', async () => {
  const { page } = run;
  await startThread(page, sandbox, '[text] bottom panel');
  await expect(page.locator('.hc-messages')).toContainText('Streaming reply from the fixture session.');
  const app = page.locator('.app');

  await rightToggle(page).click();
  await expect(page.getByTestId('changes-panel')).toBeVisible();
  await expect(rightToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(bottomToggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(app).toHaveClass(/app--terminal-closed/);

  const right = page.locator('.app__panel');
  await expect(right.locator('.hc-panel__title')).toHaveText('변경사항');
  await expect(right.getByRole('radio')).toHaveCount(0);
  await expect(right.getByRole('tab')).toHaveCount(0);
  await expect(right.getByText('터미널', { exact: true })).toHaveCount(0);
  await expect(right.getByTestId('terminal')).toHaveCount(0);
});

test('both panels open together: terminal under the chat, 변경사항 on the right, no overlap', async () => {
  const { page } = run;
  const app = page.locator('.app');
  await bottomToggle(page).click();
  await expect(app).toHaveClass(/app--terminal-open/);
  await expect(app).toHaveClass(/app--panel-open/);
  await expect(bottomToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(rightToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(bottomTerminal(page).locator('.xterm')).toBeVisible();
  await expect(page.getByTestId('changes-panel')).toBeVisible();

  // The thread's worktree is shown ~-abbreviated or absolute, never empty.
  await expect(page.getByTestId('terminal-cwd')).toContainText('worktrees');

  const terminal = await box(page, bottomTerminal(page));
  const composer = await box(page, page.locator('.hc-composer'));
  const right = await box(page, page.locator('.app__panel .hc-panel'));
  expect(terminal.y).toBeGreaterThanOrEqual(composer.y + composer.height - 1);
  expect(terminal.x + terminal.width).toBeLessThanOrEqual(right.x + 1);

  await bottomTerminal(page).locator('.xterm').click();
  await page.keyboard.type('echo "BOTH=[$((6*7))]"\n');
  await expect
    .poll(async () => ((await bottomTerminal(page).locator('.xterm-rows').textContent()) ?? '').replace(/\s+/g, ''), { timeout: 20_000 })
    .toContain('BOTH=[42]');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v6-both-panels', SHOTS);

  // ⌘⇧D closes only the right panel; the terminal stays.
  await menuShortcut(run.app, 'CmdOrCtrl+Shift+D');
  await expect(app).toHaveClass(/app--panel-closed/);
  await expect(app).toHaveClass(/app--terminal-open/);
  await expect(rightToggle(page)).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v6-bottom-terminal', SHOTS);

  // Command palette names the bottom terminal.
  await menuShortcut(run.app, 'CmdOrCtrl+K');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('하단 터미널');
  await expect(palette.getByRole('option').first()).toContainText('하단 터미널 닫기');
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('restart: the header button swaps in a fresh shell in the same folder', async () => {
  const { page } = run;
  const terminal = bottomTerminal(page);
  await terminal.locator('.xterm').click();
  await page.keyboard.type('export HOPECODE_R=1; echo "R=[$HOPECODE_R]"\n');
  const text = async () => ((await terminal.locator('.xterm-rows').textContent()) ?? '').replace(/\s+/g, '');
  await expect.poll(text, { timeout: 20_000 }).toContain('R=[1]');
  await page.getByTestId('bottom-panel').getByRole('button', { name: '터미널 재시작' }).click();
  await expect.poll(text, { timeout: 5_000 }).not.toContain('R=[1]');
  await expect(terminal.locator('.app__terminal-exited')).toHaveCount(0);
  await terminal.locator('.xterm').click();
  await page.keyboard.type('echo "AFTER=[${HOPECODE_R:-unset}]"\n');
  await expect.poll(text, { timeout: 20_000 }).toContain('AFTER=[unset]');
});

test('dragging the top edge resizes the terminal (clamped, refitted) and the height persists across a restart', async () => {
  const { page } = run;
  const panel = page.getByTestId('bottom-panel');
  const handle = panel.getByRole('separator', { name: '터미널 높이 조절' });
  const xtermRows = (p: Page) => p.evaluate(() => document.querySelectorAll('[data-testid="bottom-panel"] .xterm-rows > div').length);
  const dragBy = async (dy: number) => {
    const h = await box(page, handle);
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy / 2, { steps: 4 });
    await page.mouse.move(x, y + dy, { steps: 4 });
    await page.mouse.up();
  };

  // Clamps: never below 120px, never above 70% of the window.
  await dragBy(2000);
  expect(Math.round((await box(page, panel)).height)).toBe(120);
  const viewport = await page.evaluate(() => window.innerHeight);
  await dragBy(-2000);
  const tallest = (await box(page, panel)).height;
  expect(tallest).toBeLessThanOrEqual(Math.ceil(viewport * 0.7) + 1);
  expect(tallest).toBeGreaterThan(120);

  // Down to the minimum again, then 100px up: the pane grows by the drag and xterm refits to more rows.
  await dragBy(2000);
  await expect.poll(() => xtermRows(page)).toBeGreaterThan(0);
  const minRows = await xtermRows(page);
  await dragBy(-100);
  const dragged = await box(page, panel);
  expect(Math.round(dragged.height)).toBeGreaterThanOrEqual(215);
  expect(Math.round(dragged.height)).toBeLessThanOrEqual(225);
  await expect.poll(() => xtermRows(page)).toBeGreaterThan(minRows);
  const draggedRows = await xtermRows(page);
  const stored = await page.evaluate(() => Number(localStorage.getItem('hopecode.terminalHeight')));
  expect(Math.abs(stored - dragged.height)).toBeLessThanOrEqual(1);

  await run.app.close();
  run = await launch(sandbox);
  const reopened = run.page;
  await reopened.getByTestId('sidebar').locator('.hc-thread').first().click();
  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(reopened.locator('.app')).toHaveClass(/app--terminal-open/);
  await expect(bottomTerminal(reopened).locator('.xterm')).toBeVisible();
  const restored = await box(reopened, reopened.getByTestId('bottom-panel'));
  expect(Math.abs(restored.height - dragged.height)).toBeLessThanOrEqual(1);
  await expect.poll(() => xtermRows(reopened)).toBe(draggedRows);
});
