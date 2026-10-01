// v19: agent turns read as one dialogue box. Consecutive quiet tool calls fold into one summary line (expand -> one
// row per call, a row -> its output), failures open their group, diff cards stay out of groups. Fixture mode only:
// fakeQuery's `[toolrun]` / `[toolfail]` turns (8 calls in a row, then an Edit with a diff).
import { expect, test, type Page } from '@playwright/test';
import { createSandbox, launch, screenshot, sendMessage, startThread, type Launched, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

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

const messages = (page: Page) => page.locator('.hc-messages');
const lastTurn = (page: Page) => messages(page).getByTestId('agent-turn').last();

test('consecutive calls fold into one collapsed summary line; the diff card stays out', async () => {
  const { page } = run;
  await startThread(page, sandbox, '저장소를 확인하고 인사말을 바꿔 주세요 [toolrun]');
  await expect(messages(page)).toContainText('인사말을 "Hello Hopecode"로 바꿨습니다.');

  const turn = lastTurn(page);
  // One dialogue box for the whole turn: one portrait, one name tag, every paragraph inside it.
  await expect(turn.locator('.hc-say')).toHaveCount(1);
  await expect(turn.locator('.hc-agent-name')).toHaveCount(1);
  await expect(turn.locator('.hc-agent-avatar')).toHaveCount(1);
  await expect(turn.locator('.hc-msg-assistant')).toHaveCount(3);

  const group = turn.getByTestId('tool-group');
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('data-count', '8');
  await expect(group).toHaveAttribute('data-state', 'done');
  const summary = group.locator('.hc-toolgroup__summary');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(group.getByTestId('tool-group-label')).toHaveText('명령 5 · 파일 읽기 2 · 검색 1');
  await expect(summary).toContainText(/\d+(\.\d)?(ms|s)/);
  await expect(group.locator('.hc-tool__status--ok')).toBeVisible();
  await expect(group.getByTestId('tool-group-failed')).toHaveCount(0);
  // Collapsed: no rows on screen.
  await expect(group.locator('.hc-tool--row')).toHaveCount(0);

  // The Edit keeps its own framed card (diff), outside the group.
  const edit = turn.locator('.hc-tool').filter({ hasText: 'Edit' });
  await expect(edit).toHaveCount(1);
  await expect(edit).not.toHaveClass(/hc-tool--row/);
  await expect(group.locator('.hc-tool').filter({ hasText: 'Edit' })).toHaveCount(0);
  // Cards keep a flat 2px frame: no drop on hover.
  await edit.locator('.hc-tool__header').hover();
  expect(await edit.evaluate((el) => getComputedStyle(el).boxShadow)).not.toContain('3px 3px');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v19-tools-collapsed', SHOTS);
});

test('expand: one frameless row per call; a row opens its output; keyboard toggles', async () => {
  const { page } = run;
  const group = lastTurn(page).getByTestId('tool-group');
  const summary = group.locator('.hc-toolgroup__summary');
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  const rows = group.locator('.hc-tool--row');
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toContainText('Bash');
  await expect(rows.first()).toContainText('git status --short');
  await expect(rows.nth(5)).toContainText('README.md');
  await expect(rows.first().locator('.hc-tool__duration')).toHaveText(/\d/);
  // Rows carry no frame.
  expect(await rows.first().evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');

  const row = rows.first();
  const header = row.locator('.hc-tool__header');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(row.getByTestId('tool-output')).toContainText('M README.md');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v19-tools-expanded', SHOTS);

  // Keyboard: Enter / Space on the focused buttons.
  await header.focus();
  await page.keyboard.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(group.locator('.hc-tool--row')).toHaveCount(0);
});

test('expanded state is remembered across thread switches', async () => {
  const { page } = run;
  const summary = lastTurn(page).getByTestId('tool-group').locator('.hc-toolgroup__summary');
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  const title = (await page.locator('.app__thread-name').textContent()) ?? '';
  // Another thread, then back.
  await startThread(page, sandbox, '다른 스레드 [text]');
  await expect(messages(page)).toContainText('Streaming reply from the fixture session.');
  await page.getByTestId('sidebar').locator('.hc-thread').filter({ hasText: title }).first().click();
  await expect(lastTurn(page).getByTestId('tool-group').locator('.hc-toolgroup__summary')).toHaveAttribute('aria-expanded', 'true');
});

test('a failed call opens its group and shows 실패 1', async () => {
  const { page } = run;
  await sendMessage(page, '테스트도 돌려 주세요 [toolfail]');
  await expect(messages(page)).toContainText('테스트 스크립트는 없지만 인사말은 바꿨습니다.');
  const group = lastTurn(page).getByTestId('tool-group');
  await expect(group).toHaveAttribute('data-state', 'error');
  await expect(group.locator('.hc-toolgroup__summary')).toHaveAttribute('aria-expanded', 'true');
  await expect(group.getByTestId('tool-group-failed')).toHaveText('실패 1');
  const failed = group.locator('.hc-tool--row[data-state="error"]');
  await expect(failed).toHaveCount(1);
  // The failing call shows its output right away.
  await expect(failed.getByTestId('tool-output')).toContainText('Missing script');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v19-tools-failed', SHOTS);
});
