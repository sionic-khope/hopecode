// v20: the turn scrubber. A column of ticks on the conversation's left edge, one per user message: hover shows a
// preview card (prompt + answer start, code left out), a click scrolls to that message, the current turn carries
// aria-current, ⌥↓ steps to the next turn, bookmarks survive a restart. Fixture mode only (fakeQuery `[table]` /
// `[code]` / `[text]` replies).
import { expect, test, type Page } from '@playwright/test';
import { createSandbox, launch, screenshot, sendMessage, startThread, type Launched, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

const PROMPTS = [
  '[table] 작성 지침을 표로 정리해 주세요',
  '[code] 인사 도우미 함수를 보여 주세요',
  '[text] 세 번째 질문입니다',
  '[table] 네 번째로 다시 표를 주세요',
  '[code] 다섯 번째 코드 예시',
  '[text] 여섯 번째 확인',
  '[table] 일곱 번째 마무리 표',
];

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

const scrubber = (page: Page) => page.getByRole('navigation', { name: '대화 턴' });
const ticks = (page: Page) => scrubber(page).getByTestId('turn-tick');
const bubbles = (page: Page) => page.locator('.hc-messages .hc-msg-user__bubble');

async function threadStatus(page: Page): Promise<string | undefined> {
  const state = (await page.evaluate(() => window.hopecode.invoke('app:bootstrap'))) as { threads: { status: string }[] };
  return state.threads[0]?.status;
}

async function waitIdle(page: Page): Promise<void> {
  await expect.poll(() => threadStatus(page), { timeout: 20_000 }).toBe('idle');
}

test('one tick per user message; hidden under two turns; the last turn is current', async () => {
  const { page } = run;
  await startThread(page, sandbox, PROMPTS[0]!);
  await waitIdle(page);
  // A single turn has nothing to scrub.
  await expect(scrubber(page)).toHaveCount(0);

  for (const prompt of PROMPTS.slice(1)) {
    await sendMessage(page, prompt);
    await expect(bubbles(page).last()).toHaveText(prompt);
    await waitIdle(page);
  }
  await expect(bubbles(page)).toHaveCount(PROMPTS.length);
  await expect(scrubber(page)).toBeVisible();
  await expect(ticks(page)).toHaveCount(PROMPTS.length);
  await expect(ticks(page).nth(1)).toHaveAttribute('aria-label', `턴 2: ${PROMPTS[1]}`);
  // Stuck to the bottom: the last turn is the one being read; nothing is running any more.
  await expect(ticks(page).last()).toHaveAttribute('aria-current', 'true');
  await expect(scrubber(page).locator('[aria-current]')).toHaveCount(1);
  await expect(scrubber(page).locator('[data-live]')).toHaveCount(0);
});

test('hover shows the preview card: prompt, answer start without code, bookmark button', async () => {
  const { page } = run;
  const card = scrubber(page).getByTestId('turn-preview');
  await expect(card).toHaveCount(0);
  await ticks(page).nth(1).hover();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('turn-preview-prompt')).toHaveText(PROMPTS[1]!);
  await expect(card.getByTestId('turn-preview-reply')).toHaveText('Here is the helper: Call it with your name.');
  await expect(card).not.toContainText('export function');
  await expect(card.getByRole('button', { name: '북마크' })).toHaveAttribute('aria-pressed', 'false');
  // Neighbours swell around the hovered tick (gaussian), far ticks stay at rest.
  const mag = (i: number) => ticks(page).nth(i).evaluate((el) => Number((el as HTMLElement).style.getPropertyValue('--mag') || 0));
  await expect.poll(() => mag(1)).toBeGreaterThan(0.9);
  const near = await mag(0);
  expect(near).toBeGreaterThan(0);
  expect(near).toBeLessThan(1);
  expect(await mag(6)).toBe(0);

  // The card follows the ticks and stays open while the pointer moves onto it.
  await ticks(page).nth(2).hover();
  await expect(card.getByTestId('turn-preview-prompt')).toHaveText(PROMPTS[2]!);
  await expect(card.getByTestId('turn-preview-reply')).toHaveText('Streaming reply from the fixture session.');
  await ticks(page).nth(3).hover();
  await expect(card.getByTestId('turn-preview-prompt')).toHaveText(PROMPTS[3]!);
  await expect(card.getByTestId('turn-preview-reply')).toContainText('작성 지침입니다. 존댓말로 씁니다.');
  await card.getByTestId('turn-preview-prompt').hover();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('turn-preview-prompt')).toHaveText(PROMPTS[3]!);
  await screenshot(page, 'v20-scrubber', SHOTS);
});

test('a click scrolls to that message, flashes it and moves aria-current', async () => {
  const { page } = run;
  await expect(bubbles(page).first()).not.toBeInViewport();
  await ticks(page).first().click();
  await expect(bubbles(page).first()).toBeInViewport();
  await expect(page.locator('.hc-msg-user').first()).toHaveClass(/hc-msg-user--arrive/);
  await expect(ticks(page).first()).toHaveAttribute('aria-current', 'true');
  await expect(scrubber(page).locator('[aria-current]')).toHaveCount(1);

  // Clicking the card jumps too.
  await page.mouse.move(0, 0);
  await ticks(page).nth(4).hover();
  await scrubber(page).getByTestId('turn-preview').click();
  await expect(bubbles(page).nth(4)).toBeInViewport();
  await expect(ticks(page).nth(4)).toHaveAttribute('aria-current', 'true');
});

test('scrolling by hand updates the current turn', async () => {
  const { page } = run;
  await page.mouse.move(0, 0);
  await page.locator('.hc-messages').evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(ticks(page).first()).toHaveAttribute('aria-current', 'true');
  await page.locator('.hc-messages').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(ticks(page).last()).toHaveAttribute('aria-current', 'true');
});

test('⌥↑ / ⌥↓ step between turns from anywhere in the chat', async () => {
  const { page } = run;
  await ticks(page).nth(2).click();
  await expect(ticks(page).nth(2)).toHaveAttribute('aria-current', 'true');
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Alt+ArrowDown');
  await expect(ticks(page).nth(3)).toHaveAttribute('aria-current', 'true');
  await expect(bubbles(page).nth(3)).toBeInViewport();
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(ticks(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(bubbles(page).nth(1)).toBeInViewport();

  // In the composer with text, ⌥↑ keeps its caret meaning.
  const box = page.locator('.hc-composer__textarea');
  await box.fill('줄 하나\n줄 둘');
  await box.press('Alt+ArrowUp');
  await expect(ticks(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await box.fill('');
});

test('keyboard inside the scrubber: arrows move, B bookmarks, Enter jumps', async () => {
  const { page } = run;
  await page.mouse.move(0, 0);
  await ticks(page).nth(1).focus();
  await page.keyboard.press('ArrowDown');
  await expect(ticks(page).nth(2)).toBeFocused();
  await expect(scrubber(page).getByTestId('turn-preview-prompt')).toHaveText(PROMPTS[2]!);
  await page.keyboard.press('b');
  await expect(ticks(page).nth(2)).toHaveAttribute('data-bookmarked', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(ticks(page).nth(3)).toHaveAttribute('aria-current', 'true');
  await expect(bubbles(page).nth(3)).toBeInViewport();
});

test('bookmarks from the card persist in main and survive a restart', async () => {
  const { page } = run;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await ticks(page).nth(5).hover();
  const mark = scrubber(page).getByTestId('turn-bookmark');
  await mark.click();
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await expect(ticks(page).nth(5)).toHaveAttribute('data-bookmarked', 'true');
  // Toggle off and on again: one entry, no duplicates.
  await mark.click();
  await expect(ticks(page).nth(5)).not.toHaveAttribute('data-bookmarked', /.*/);
  await mark.click();
  await expect(ticks(page).nth(5)).toHaveAttribute('data-bookmarked', 'true');

  const saved = async () => {
    const state = (await page.evaluate(() => window.hopecode.invoke('app:bootstrap'))) as { threads: { turnBookmarks?: string[] }[] };
    return state.threads[0]?.turnBookmarks ?? [];
  };
  await expect.poll(async () => (await saved()).length).toBe(2);
  const ids = await saved();

  await run.app.close();
  run = await launch(sandbox);
  const { page: next } = run;
  await next.getByTestId('sidebar').locator('.hc-thread').first().click();
  await expect(ticks(next)).toHaveCount(PROMPTS.length);
  await expect(ticks(next).nth(2)).toHaveAttribute('data-bookmarked', 'true');
  await expect(ticks(next).nth(5)).toHaveAttribute('data-bookmarked', 'true');
  await expect(scrubber(next).locator('[data-bookmarked]')).toHaveCount(2);
  const after = (await next.evaluate(() => window.hopecode.invoke('app:bootstrap'))) as { threads: { turnBookmarks?: string[] }[] };
  expect(after.threads[0]?.turnBookmarks).toEqual(ids);
});

test('a subagent view hides the scrubber; back in the main chat it returns', async () => {
  const { page } = run;
  await sendMessage(page, '[subagents] 저장소를 나눠서 조사해 주세요');
  await waitIdle(page);
  await expect(ticks(page)).toHaveCount(PROMPTS.length + 1);
  await page.locator('.hc-messages').getByTestId('subagent-card').first().getByTestId('subagent-open').click();
  await expect(page.locator('.hc-messages').getByTestId('subagent-detail')).toBeVisible();
  await expect(scrubber(page)).toHaveCount(0);
  await page.getByTestId('subagent-back').click();
  await expect(scrubber(page)).toBeVisible();
  await expect(ticks(page)).toHaveCount(PROMPTS.length + 1);
});
