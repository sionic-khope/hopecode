// Per-agent new-chat defaults (plan 2.11, AC10): a draft shows Opus 5.5 · High (Claude), GPT-6.1-Sol · High (Codex)
// or 시스템 기본값 (Hermes), the started session really runs with them, and Settings changes reach the next draft.
import { expect, test, type Page } from '@playwright/test';
import {
  chooseFixtureFolder,
  createSandbox,
  launch,
  openDraft,
  openFromMore,
  pickAgent,
  screenshot,
  sendMessage,
  type Launched,
  type Sandbox,
} from './helpers';

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

const draftModel = (page: Page) => page.getByTestId('draft').locator('.hc-chip--model');

/** Sends `text` and returns the JSON of the fixture ACP agent's new `CONFIG ` reply. */
async function config(page: Page, text: string): Promise<Record<string, unknown>> {
  const replies = page.locator('.hc-messages').getByText(/^CONFIG \{/);
  const before = await replies.count();
  await sendMessage(page, text);
  await expect(replies).toHaveCount(before + 1);
  const body = (await replies.last().textContent()) ?? '';
  return JSON.parse(body.slice(body.indexOf('{'))) as Record<string, unknown>;
}

test('switching the draft agent resets the model chip to that agent\'s default', async () => {
  const { page } = run;
  await openDraft(page);
  await expect(draftModel(page)).toHaveAttribute('aria-label', '모델: Opus 5.5 · High');
  await pickAgent(page, 'Codex');
  await expect(draftModel(page)).toHaveAttribute('aria-label', '모델: GPT-6.1-Sol · High');
  await pickAgent(page, 'Hermes');
  await expect(page.getByTestId('draft').getByTestId('system-model-tag')).toHaveText('DeepSeek V4.1 Flash Ultrafast');
  await pickAgent(page, 'Claude Code');
  await expect(draftModel(page)).toHaveAttribute('aria-label', '모델: Opus 5.5 · High');
});

test('the defaults reach the sessions: Claude Query, Codex -c, Hermes untouched', async () => {
  const { page } = run;
  await chooseFixtureFolder(page, sandbox);
  await sendMessage(page, '[whoami] claude defaults');
  await expect(page.locator('.hc-messages')).toContainText('model=claude-opus-5-5');
  await expect(page.locator('.hc-messages')).toContainText('effort=high');

  await openDraft(page);
  await pickAgent(page, 'Codex');
  await chooseFixtureFolder(page, sandbox);
  // Spawned with -c model / effort: already right, so no set_config_option correction either.
  expect(await config(page, '/config')).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'high', configSets: [] });

  await openDraft(page);
  await pickAgent(page, 'Hermes');
  await chooseFixtureFolder(page, sandbox);
  expect(await config(page, '/config')).toMatchObject({ profile: 'hermes', configSets: [] });
});

test('Settings: per-agent defaults apply to the next draft and its session', async () => {
  const { page } = run;
  await openFromMore(page, '설정');
  const settings = page.getByTestId('settings');
  const section = settings.getByRole('region', { name: '새 채팅 기본 모델' });
  await expect(section.getByTestId('hermes-default')).toHaveText('시스템 기본값 (DeepSeek V4.1 Flash Ultrafast · og)');
  await section.getByRole('radiogroup', { name: '기본 effort', exact: true }).getByRole('radio', { name: 'Low', exact: true }).click();
  await section.getByRole('radiogroup', { name: 'Codex 기본 effort' }).getByRole('radio', { name: 'Medium', exact: true }).click();
  // The Codex list is what the fixture session reported (gpt-6.1-sol / gpt-6-sol).
  await section.getByRole('button', { name: /^Codex 기본 모델/ }).click();
  await page.getByRole('menu', { name: 'Codex 기본 모델' }).getByRole('menuitemradio', { name: 'gpt-6-sol' }).click();
  await expect
    .poll(async () => ((await page.evaluate(() => window.hopecode.invoke('app:bootstrap'))) as { settings: Record<string, unknown> }).settings)
    .toMatchObject({ defaultEffort: 'low', codexDefaultEffort: 'medium', codexDefaultModel: 'gpt-6-sol' });
  await page.mouse.move(10, 700);
  await screenshot(page, 'v7-settings-agent-defaults', SHOTS);

  await openDraft(page);
  await expect(draftModel(page)).toHaveAttribute('aria-label', '모델: Opus 5.5 · Low');
  await pickAgent(page, 'Codex');
  await expect(draftModel(page)).toHaveAttribute('aria-label', '모델: gpt-6-sol · Medium');
  await chooseFixtureFolder(page, sandbox);
  expect(await config(page, '/config')).toMatchObject({ model: 'gpt-6-sol', reasoning_effort: 'medium', configSets: [] });
});
