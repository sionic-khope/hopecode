// 표시 이름: 설정 > 일반 입력란 -> 프로필 행 이름과 아바타 이니셜.
import { expect, test } from '@playwright/test';
import { createSandbox, launch, openDraft, openFromMore, screenshot, type Launched, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
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

test('설정에서 표시 이름을 바꾸면 프로필 행과 이니셜이 바뀐다', async () => {
  const { page } = run;
  await openFromMore(page, '설정');
  const input = page.getByRole('textbox', { name: '표시 이름' });
  await expect(input).toHaveAttribute('placeholder', '이름 (예: 케이홉)');
  await input.fill('케이홉');
  await input.press('Enter');
  const row = page.getByTestId('profile-row');
  await expect(row.locator('.hc-profile__name')).toHaveText('케이홉');
  await expect(row.locator('.hc-avatar')).toHaveText('케');

  // 메뉴의 "표시 이름 변경…" 은 설정 입력란으로 이동한다.
  await openDraft(page);
  await row.click();
  await page.mouse.move(5, 700);
  await screenshot(page, 'v9-profile', SHOTS);
  await page.getByRole('menuitem', { name: /표시 이름 변경/ }).click();
  await expect(input).toBeFocused();

  await input.fill('');
  await input.press('Enter');
  await expect(row.locator('.hc-profile__name')).not.toHaveText('케이홉');
});
