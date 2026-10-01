// Hermes' real system default model (fixture: og / deepseek/deepseek-v4.1-flash-ultrafast) in the agent menu, the draft
// chip (with provider + raw id tooltip), Settings and the Accounts card. Fixture mode only; nothing is sent to Hermes.
import { expect, test } from '@playwright/test';
import { createSandbox, launch, openDraft, openFromMore, pickAgent, screenshot, type Launched, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';
const LABEL = 'DeepSeek V4.1 Flash Ultrafast';

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

test('menu, draft chip, settings and accounts show the detected Hermes model', async () => {
  const { page } = run;
  await openDraft(page);
  await page.getByTestId('draft').locator('.hc-chip--agent').click();
  await expect(page.getByRole('menu', { name: '에이전트' })).toContainText(`Nous Research · ${LABEL}`);
  await page.keyboard.press('Escape');
  await pickAgent(page, 'Hermes');
  const tag = page.getByTestId('draft').getByTestId('system-model-tag');
  await expect(tag).toHaveText(LABEL);
  await expect(tag).toHaveAttribute('title', /og · deepseek\/deepseek-v4\.1-flash-ultrafast/);
  await page.getByTestId('draft').locator('.hc-chip--agent').click();
  await screenshot(page, 'v10-hermes-model', SHOTS);
  await page.keyboard.press('Escape');

  await openFromMore(page, '설정');
  await expect(page.getByTestId('hermes-default')).toHaveText(`시스템 기본값 (${LABEL} · og)`);
  await expect(page.getByTestId('settings')).toContainText('hermes model');

  await openFromMore(page, '계정');
  await expect(page.getByTestId('local-auth-model-hermes')).toHaveText(`${LABEL} · og`);
});
