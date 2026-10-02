// v21: code and diff visibility. Long lines scroll sideways (or soft-wrap on request) instead of being cut, a large
// diff / code block / tool output shows its first lines with an "N줄 더 보기" button, an unchanged run in a diff folds
// behind an expander, and code blocks use more width than the reading measure of the text around them. Fixture mode
// only: fakeQuery's `[bigdiff]` turn (fenced block with a long line, Edit with two hunks, 40-line Bash output, a
// 72-line Write, README.md rewritten with long lines for the changes panel).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createSandbox, launch, screenshot, startThread, type Launched, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';
/** `before` captures the pre-change UI (run with --grep screens); everything else runs as `after`. */
const PHASE = process.env['HOPECODE_V21_PHASE'] ?? 'after';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
  await startThread(run.page, sandbox, '리포트 로더를 고쳐 주세요 [bigdiff]');
  await expect(run.page.locator('.hc-messages')).toContainText('로더와 샘플을 바꿨습니다.');
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

const turn = (page: Page) => page.locator('.hc-messages').getByTestId('agent-turn').last();
const card = (page: Page, name: string) => turn(page).locator('.hc-tool:not(.hc-tool--row)').filter({ has: page.locator('.hc-tool__name', { hasText: new RegExp(`^${name}$`) }) });

async function openCard(page: Page, name: string): Promise<Locator> {
  const c = card(page, name);
  const header = c.locator('.hc-tool__header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await expect(c.locator('.hc-tool__body')).toBeVisible();
  return c;
}

async function shot(page: Page, target: Locator, name: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await page.mouse.move(5, 700);
  await screenshot(page, `v21-code-${PHASE}-${name}`, SHOTS);
}

test('screens: edit diff, big write, code block, tool output, changes panel', async () => {
  const { page } = run;
  const edit = await openCard(page, 'Edit');
  await shot(page, edit, 'edit');
  const write = await openCard(page, 'Write');
  await shot(page, write, 'write');
  await shot(page, turn(page).locator('.hc-code').first(), 'codeblock');
  const bash = turn(page).locator('.hc-tool--row').filter({ hasText: 'npm run lint' });
  await bash.locator('.hc-tool__header').click();
  await expect(bash.getByTestId('tool-output')).toBeVisible();
  await shot(page, bash, 'tool-output');

  await page.getByRole('button', { name: '변경사항 패널', exact: true }).click();
  const panel = page.getByTestId('changes-panel');
  const readme = panel.locator('.hc-changes__file[data-path="README.md"]');
  await expect(readme).toBeVisible();
  if ((await readme.getAttribute('aria-expanded')) !== 'true') await readme.click();
  await expect(panel.locator('.hc-diff__row--add').first()).toContainText('Hello world, this README line');
  await page.mouse.move(5, 700);
  await screenshot(page, `v21-code-${PHASE}-changes`, SHOTS);
  await page.getByRole('button', { name: '변경사항 패널', exact: true }).click();
  await expect(page.getByRole('button', { name: '변경사항 패널', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('a long diff line is not cut: the diff scrolls sideways, and the wrap toggle folds it instead', async () => {
  const { page } = run;
  const edit = await openCard(page, 'Edit');
  const diff = edit.locator('.hc-diff');
  await expect(diff).toBeVisible();
  const scroller = diff.getByTestId('diff-scroll');
  const long = scroller.locator('.hc-diff__row--add').filter({ hasText: 'must stay reachable' });
  await expect(long).toHaveCount(1);
  // Sideways scroll, and the row's text is laid out in full (no ellipsis / hidden overflow on the line itself).
  expect(await scroller.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
  const widths = await scroller.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(widths.scroll).toBeGreaterThan(widths.client);
  const text = long.locator('.hc-diff__text');
  expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  // Scrolled to the end, the tail of the line is inside the visible box (measured together: panes may still settle).
  const overhang = () =>
    text.evaluate((el) => {
      const scroller = el.closest('[data-testid="diff-scroll"]')!;
      scroller.scrollLeft = scroller.scrollWidth;
      const r = document.createRange();
      r.selectNodeContents(el);
      const rects = r.getClientRects();
      return rects[rects.length - 1]!.right - scroller.getBoundingClientRect().right;
    });
  await expect.poll(overhang).toBeLessThanOrEqual(1);
  const box = (await scroller.boundingBox())!;
  // The +/- marker stays put (sticky gutter) while the code scrolls.
  const marker = long.locator('.hc-diff__marker');
  expect((await marker.boundingBox())!.x).toBeGreaterThanOrEqual(box.x - 1);

  // Soft wrap: no sideways overflow, the long line takes several visual lines.
  const wrap = diff.getByRole('button', { name: '줄바꿈' });
  await expect(wrap).toHaveAttribute('aria-pressed', 'false');
  await wrap.click();
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const rowH = await long.evaluate((el) => el.getBoundingClientRect().height);
  const lineH = await edit.locator('.hc-diff__row--context').first().evaluate((el) => el.getBoundingClientRect().height);
  expect(rowH).toBeGreaterThan(lineH * 1.5);
  await wrap.click();
  await expect(wrap).toHaveAttribute('aria-pressed', 'false');
});

test('diff: +/- markers, colour bar and word highlight; an unchanged run folds behind an expander', async () => {
  const { page } = run;
  const edit = await openCard(page, 'Edit');
  const add = edit.locator('.hc-diff__row--add').first();
  await expect(add.locator('.hc-diff__marker')).toHaveText('+');
  await expect(edit.locator('.hc-diff__row--del').first().locator('.hc-diff__marker')).toHaveText('−');
  // The changed words of a paired -/+ line are marked.
  await expect(edit.locator('.hc-diff__row--add .hc-diff__word').filter({ hasText: '2' })).toHaveCount(1);
  // Two hunks: a header row between them.
  await expect(edit.locator('.hc-diff__hunk')).toHaveCount(1);
  await expect(edit.locator('.hc-diff__hunk')).toContainText('@@ -80,5 +81,5 @@');

  // 16 unchanged lines in a row: 3 + 3 shown, 10 behind the expander.
  const fold = edit.getByRole('button', { name: /변경 없는 10줄 펼치기/ });
  await expect(fold).toBeVisible();
  await expect(edit.locator('.hc-diff__row--context').filter({ hasText: 'field7 ' })).toHaveCount(0);
  await fold.click();
  await expect(fold).toHaveCount(0);
  await expect(edit.locator('.hc-diff__row--context').filter({ hasText: 'field7 ' })).toHaveCount(1);
});

test('a big Write shows its first 40 lines and "N줄 더 보기" shows the rest', async () => {
  const { page } = run;
  const write = await openCard(page, 'Write');
  const rows = write.locator('.hc-diff__row--add');
  await expect(rows).toHaveCount(40);
  const more = write.getByRole('button', { name: '32줄 더 보기' });
  await expect(more).toBeVisible();
  await more.click();
  await expect(rows).toHaveCount(72);
  await expect(rows.last()).toHaveText(/};/);
  await expect(write.getByRole('button', { name: /줄 더 보기/ })).toHaveCount(0);
});

test('code blocks run wider than the text measure; a long block folds and opens in full', async () => {
  const { page } = run;
  const t = turn(page);
  const code = t.locator('.hc-code').first();
  const para = t.locator('.hc-md > p').first();
  const codeW = (await code.boundingBox())!.width;
  const paraW = (await para.boundingBox())!.width;
  expect(codeW).toBeGreaterThan(paraW + 40);
  // The text keeps a reading measure even though the column is wider.
  expect(await para.evaluate((el) => parseFloat(getComputedStyle(el).maxWidth))).toBeGreaterThan(0);

  // Long line: horizontal scroll inside the block (nothing clipped), mono 13px.
  const pre = code.locator('pre');
  expect(await pre.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await pre.evaluate((el) => getComputedStyle(el).fontSize)).toBe('13px');
  await expect(code.getByText('LAST_LINE_MARKER')).toHaveCount(0);
  const more = code.getByRole('button', { name: /줄 더 보기/ });
  await expect(more).toBeVisible();
  await more.click();
  await expect(code.getByText('LAST_LINE_MARKER')).toBeVisible();
  await expect(code.getByRole('button', { name: '접기' })).toBeVisible();
  // The keyword / string tokens are coloured.
  await expect(code.locator('.tok-keyword').first()).toBeVisible();
});

test('a long tool output shows its first lines and opens in full', async () => {
  const { page } = run;
  const bash = turn(page).locator('.hc-tool--row').filter({ hasText: 'npm run lint' });
  const header = bash.locator('.hc-tool__header');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const out = bash.getByTestId('tool-output');
  await expect(out).toBeVisible();
  await expect(out).not.toContainText('37 problems');
  await out.getByRole('button', { name: /줄 더 보기/ }).click();
  await expect(out).toContainText('✖ 37 problems (0 errors, 37 warnings)');
});
