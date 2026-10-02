// v23: the main conversation reads like a document. The user's line, the agent's answer and tool output drag-select
// (window.getSelection() holds the text) and ⌘C copies it; a drag that ends in a click plays no select sound; the
// user's line and the answer have a copy icon underneath. Fixture mode only (fakeQuery `[bigdiff]` turn), window hidden.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createSandbox, launch, startThread, type Launched, type Sandbox } from './helpers';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;
const ASK = '리포트 로더를 고쳐 주세요 [bigdiff]';

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
  await startThread(run.page, sandbox, ASK);
  await expect(run.page.locator('.hc-messages')).toContainText('로더와 샘플을 바꿨습니다.');
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

/** Drags across all the text of `target` (a real pointer drag); returns what the page selected. */
async function dragOver(page: Page, target: Locator): Promise<string> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const first = rects[0];
    const last = rects[rects.length - 1];
    return { x0: first.left + 1, y0: first.top + first.height / 2, x1: last.right - 1, y1: last.top + last.height / 2 };
  });
  await page.mouse.move(box.x0, box.y0);
  await page.mouse.down();
  await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 4 });
  await page.mouse.move(box.x1, box.y1, { steps: 4 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

const soundLog = (page: Page) => page.evaluate(() => (window as unknown as { __hcSoundLog?: { kind: string }[] }).__hcSoundLog ?? []);

test('user line, answer text and tool output drag-select and copy with ⌘C; no select sound on a drag', async () => {
  const { app, page } = run;
  await page.evaluate(() => {
    (window as unknown as { __hcSoundLog?: unknown[] }).__hcSoundLog = [];
  });
  const messages = page.locator('.hc-messages');

  const user = messages.locator('.hc-msg-user__bubble').last();
  expect((await dragOver(page, user)).trim()).toBe(ASK);
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await page.keyboard.press('Meta+c');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(ASK);

  const answer = messages.locator('.hc-msg-assistant .hc-md p', { hasText: '로더와 샘플을 바꿨습니다.' }).first();
  expect(await dragOver(page, answer)).toContain('로더와 샘플을 바꿨습니다.');
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await page.keyboard.press('Meta+c');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('로더와 샘플을 바꿨습니다.');

  const bash = messages.locator('.hc-tool--row').filter({ hasText: 'npm run lint' });
  await bash.locator('.hc-tool__header').click();
  const output = bash.getByTestId('tool-output');
  await expect(output).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __hcSoundLog?: unknown[] }).__hcSoundLog = [];
  });
  const firstLine = output.locator('pre, code').first();
  expect((await dragOver(page, firstLine)).length).toBeGreaterThan(0);
  // A drag is reading: no select sound, and the card stays open.
  expect((await soundLog(page)).filter((e) => e.kind === 'select')).toEqual([]);
  await expect(output).toBeVisible();
  // Selection highlight is the yellow wash, visible on black.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--selection-text').trim())).toBe('rgba(255, 225, 77, 0.3)');
});

test('the user line has a hover copy icon under it that copies its text; the answer has one too', async () => {
  const { app, page } = run;
  const row = page.locator('.hc-messages .hc-msg-user').last();
  await page.mouse.move(1, 1);
  const copy = row.getByRole('button', { name: '복사', exact: true });
  await expect.poll(() => copy.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe('0');
  await row.hover();
  await expect(copy).toBeVisible();
  await expect.poll(() => copy.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe('1');
  // Under the bubble, right-aligned with it.
  const bubbleBox = (await row.locator('.hc-msg-user__bubble').boundingBox())!;
  const copyBox = (await copy.boundingBox())!;
  expect(copyBox.y).toBeGreaterThanOrEqual(bubbleBox.y + bubbleBox.height - 1);
  expect(Math.abs(copyBox.x + copyBox.width - (bubbleBox.x + bubbleBox.width))).toBeLessThanOrEqual(8);
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await copy.click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(ASK);
  await expect(row.getByRole('button', { name: '복사됨', exact: true })).toBeVisible();

  const turn = page.getByTestId('agent-turn').last();
  const answerCopy = turn.locator('.hc-turn__foot').getByRole('button', { name: '복사', exact: true });
  await expect(answerCopy).toBeVisible();
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await answerCopy.click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('로더와 샘플을 바꿨습니다.');
});
