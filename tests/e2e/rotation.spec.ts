// A4 rate-limit switch to the next account, A5 all accounts exhausted -> Waiting countdown -> auto resend.
// Fresh app per test so each starts from the fixture pool (Work 100%, Personal 40%, Spare 0%).
import { expect, test } from '@playwright/test';
import { createSandbox, launch, screenshot, startThread, type Launched, type Sandbox } from './helpers';

let sandbox: Sandbox;
let run: Launched;

test.beforeEach(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
});

test.afterEach(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

test('rate-limited account -> next turn runs on the next available account', async () => {
  const { page } = run;
  await startThread(page, sandbox, '[ratelimit] [text] hello');
  const messages = page.locator('.hc-messages');
  await expect(messages.locator('.hc-notice').filter({ hasText: '계정 전환: Personal → Spare' })).toBeVisible();
  await expect(messages).toContainText('Streaming reply from the fixture session.');
  // Personal is now blocked until its 5h reset: 1/3 available.
  await expect(page.getByTestId('statusline')).toContainText('1/3 avail');

  await page.getByTestId('statusline').locator('.hc-statusline__trigger').click();
  const spare = page.locator('.hc-accounts-pop__row').filter({ hasText: 'Spare' });
  await expect(spare).toContainText('사용 중');
  const personal = page.locator('.hc-accounts-pop__row').filter({ hasText: 'Personal' });
  await expect(personal.locator('.hc-accounts-pop__badge')).toContainText('소진');
  await screenshot(page, '08-ratelimit-switched');
  await page.keyboard.press('Escape');
});

test('all accounts exhausted -> Waiting countdown -> automatic resend after reset', async () => {
  const { page } = run;
  await startThread(page, sandbox, '[exhaust] keep going');
  const row = page.getByTestId('sidebar').locator('.hc-thread').first();
  await expect(row.locator('.hc-thread__meta--waiting')).toContainText(/0h0m/);
  await expect(page.locator('.hc-messages .hc-notice--warn')).toContainText('모든 계정이 한도에 도달했습니다');
  await expect(page.getByTestId('statusline')).toContainText('0/3 avail');
  await screenshot(page, '09-waiting');

  // Rejections reset after 10s; the fixture wait tick (1s) resends the pending prompt.
  await expect(page.locator('.hc-messages')).toContainText('Resumed after the limit reset.', { timeout: 30_000 });
  await expect(row.locator('.hc-thread__meta--waiting')).toHaveCount(0);
  await expect(page.locator('.hc-messages .hc-msg-user__bubble')).toHaveCount(1);
  await screenshot(page, '10-waiting-resumed');
});
