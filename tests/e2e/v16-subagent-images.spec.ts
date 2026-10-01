// v16: subagent view (Codex desktop style) and agent images everywhere (Read png, MCP web captures, ACP image
// blocks, Codex collab subagents), persisted through a restart. Fixture markers: `[subagents]`, `[image]`,
// `[screenshot]` (Claude fake query); `/media`, `/spawn` (fake ACP agent, Codex profile).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_PNG_BASE64, FIXTURE_PNG_PATH, FIXTURE_SCREENSHOT_URL } from '../../src/main/fixtures/fakeQuery';
import {
  chooseFixtureFolder,
  createSandbox,
  launch,
  openDraft,
  pickAgent,
  screenshot,
  sendMessage,
  startThread,
  type Launched,
  type Sandbox,
} from './helpers';

const DIR = '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

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

async function soundKinds(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as unknown as { __hcSoundLog?: { kind: string }[] }).__hcSoundLog ?? []).map((e) => e.kind));
}

test('subagent view: open a running subagent, watch it finish live, back with Escape / breadcrumb', async () => {
  const { page } = run;
  await startThread(page, sandbox, '[subagents] 저장소 조사');
  const cards = messages(page).getByTestId('subagent-card');
  await expect(cards).toHaveCount(2);

  // Open the Explore subagent while it is still running (card "보기").
  const explore = cards.filter({ hasText: 'Explore' });
  await explore.getByTestId('subagent-open').click();
  const detail = messages(page).getByTestId('subagent-detail');
  await expect(detail).toBeVisible();
  await expect(messages(page).getByTestId('subagent-card')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '메인 대화로 돌아가기' })).toContainText('메인 대화');
  await expect(detail.locator('.hc-subview__name')).toHaveText('Explore');
  await expect(detail).toContainText('README 구조 조사');
  await expect(detail.getByTestId('subagent-detail-prompt')).toContainText('Summarize README.md.');

  // Live: its tools and text arrive while the view is open; it ends with the final report.
  await expect(detail).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  await expect(detail.getByTestId('subagent-detail-state')).toHaveText('완료');
  await expect(detail.getByTestId('subagent-detail-elapsed')).toHaveText(/초$/);
  await expect(detail.locator('.hc-tool')).toHaveCount(2);
  await expect(detail.locator('.hc-tool').first()).toContainText('Read');
  await expect(detail.locator('.hc-tool').nth(1)).toContainText('Glob');
  await expect(detail).toContainText('README는 제목과 인사말 한 줄로 되어 있습니다.');
  await expect(detail.getByTestId('subagent-detail-report')).toContainText('README.md: 제목 + 인사말 한 줄.');
  await expect(detail).not.toContainText('Grep');
  await screenshot(page, 'v16-subagent', DIR);

  await page.evaluate(() => {
    (window as unknown as { __hcSoundLog?: unknown[] }).__hcSoundLog = [];
  });
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  await expect(messages(page)).toContainText('두 서브에이전트가 모두 끝났습니다');
  expect(await soundKinds(page)).toContain('back');

  // PARTY line member -> the other subagent; the breadcrumb goes back.
  await messages(page).getByTestId('subagent-party-member').filter({ has: page.locator('[title="code-reviewer"]') }).click();
  await expect(detail.locator('.hc-subview__name')).toHaveText('code-reviewer');
  await expect(detail.locator('.hc-tool')).toHaveCount(1);
  await expect(detail.locator('.hc-tool').first()).toContainText('Grep');
  await detail.getByTestId('subagent-back').click();
  await expect(detail).toHaveCount(0);
});

test('Read png result: inline thumbnail -> lightbox with 저장 / 복사', async () => {
  const { page } = run;
  await sendMessage(page, '[image] 미리보기 만들기');
  await expect(messages(page)).toContainText(`${FIXTURE_PNG_PATH} 이미지를 만들었습니다.`, { timeout: 15_000 });
  const thumb = messages(page).locator('.hc-tool').getByTestId('image-thumb');
  await expect(thumb).toHaveCount(1);
  await thumb.click();
  const lightbox = page.getByRole('dialog', { name: FIXTURE_PNG_PATH });
  await expect(lightbox.getByTestId('image-lightbox').locator('img')).toBeVisible();
  await lightbox.getByRole('button', { name: '저장' }).click();
  await expect(lightbox.getByRole('status')).toHaveText('이미지를 저장했습니다');
  const exports = join(sandbox.home, 'home', 'exports');
  const saved = readdirSync(exports).find((f) => f.endsWith('.png'));
  expect(saved).toBeDefined();
  expect(readFileSync(join(exports, saved!)).toString('base64')).toBe(FIXTURE_PNG_BASE64);
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
});

test('MCP web captures (Playwright screenshot, Claude in Chrome) show in their tool cards with tool · URL', async () => {
  const { page } = run;
  await sendMessage(page, '[screenshot] 페이지 캡처');
  await expect(messages(page)).toContainText('두 화면 캡처를 확인했습니다.', { timeout: 15_000 });
  // The earlier Read of the png keeps the first strip; the two captures follow.
  const strips = messages(page).locator('.hc-tool').getByTestId('tool-images');
  await expect(strips).toHaveCount(3);
  const playwright = strips.nth(1);
  await expect(playwright.getByTestId('tool-images-caption')).toHaveText(`playwright · browser_take_screenshot · ${FIXTURE_SCREENSHOT_URL}`);
  await expect(playwright.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(strips.nth(2).getByTestId('tool-images-caption')).toHaveText('claude-in-chrome · computer');
  // The card result text is the MCP text, not a base64 dump.
  await expect(messages(page)).not.toContainText(FIXTURE_PNG_BASE64.slice(0, 32));
  await screenshot(page, 'v16-images', DIR);

  await playwright.getByTestId('image-thumb').click();
  const lightbox = page.getByRole('dialog');
  await expect(lightbox).toContainText(FIXTURE_SCREENSHOT_URL);
  await expect(lightbox.getByRole('button', { name: '복사' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
});

test('ACP (Codex): image message chunk, image generation, MCP screenshot and spawnAgent subagent', async () => {
  const { page } = run;
  await openDraft(page);
  await pickAgent(page, 'Codex');
  await chooseFixtureFolder(page, sandbox);
  await sendMessage(page, '/media');
  await expect(messages(page)).toContainText('캡처 완료.', { timeout: 15_000 });
  const thumbs = messages(page).getByTestId('image-thumb');
  // Message image + generated image + MCP screenshot.
  await expect(thumbs).toHaveCount(3);
  await expect(messages(page).locator('.hc-say-images').getByTestId('image-thumb')).toHaveCount(1);
  await expect(messages(page).getByTestId('tool-images-caption').filter({ hasText: 'https://example.com/acp-capture' })).toHaveText(
    'playwright · browser_take_screenshot · https://example.com/acp-capture',
  );
  await expect(messages(page)).not.toContainText('아직 표시되지 않습니다');
  await expect(messages(page)).not.toContainText(FIXTURE_PNG_BASE64.slice(0, 32));

  await sendMessage(page, '/spawn');
  await expect(messages(page)).toContainText('서브에이전트가 끝났습니다.', { timeout: 15_000 });
  const card = messages(page).getByTestId('subagent-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('codex-agent');
  await expect(card).toHaveAttribute('data-state', 'done');
  await card.getByTestId('subagent-open').click();
  const detail = messages(page).getByTestId('subagent-detail');
  await expect(detail.getByTestId('subagent-detail-prompt')).toContainText('README.md를 한 줄로 요약해 줘');
  await expect(detail.getByTestId('subagent-detail-report')).toContainText('README는 제목과 인사말 한 줄입니다.');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
});

test('after a restart: images come from the media store (not the log) and subagent views still open', async () => {
  await run.app.close();
  // The logs hold refs only.
  const threadsDir = join(sandbox.home, 'userData', 'threads');
  for (const file of readdirSync(threadsDir)) {
    expect(readFileSync(join(threadsDir, file), 'utf8')).not.toContain(FIXTURE_PNG_BASE64.slice(0, 32));
  }
  expect(readdirSync(join(sandbox.home, 'userData', 'media')).length).toBeGreaterThan(0);

  run = await launch(sandbox);
  const { page } = run;
  const sidebar = page.getByTestId('sidebar');
  await sidebar.locator('.hc-thread').filter({ hasText: '저장소 조사' }).click();
  const strips = messages(page).locator('.hc-tool').getByTestId('tool-images');
  await expect(strips).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(strips.nth(i).locator('img')).toHaveAttribute('src', `data:image/png;base64,${FIXTURE_PNG_BASE64}`);
  }
  await expect(strips.nth(1).getByTestId('tool-images-caption')).toContainText(FIXTURE_SCREENSHOT_URL);
  await messages(page).getByTestId('subagent-card').filter({ hasText: 'Explore' }).getByTestId('subagent-open').click();
  const detail = messages(page).getByTestId('subagent-detail');
  await expect(detail.locator('.hc-tool')).toHaveCount(2);
  await expect(detail.getByTestId('subagent-detail-report')).toContainText('README.md: 제목 + 인사말 한 줄.');
  await detail.getByTestId('subagent-back').click();

  await sidebar.locator('.hc-thread').filter({ hasText: '/media' }).click();
  await expect(messages(page).getByTestId('image-thumb')).toHaveCount(3);
  await expect(messages(page).getByTestId('image-thumb').first().locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
});
