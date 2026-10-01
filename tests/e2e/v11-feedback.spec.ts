// v11: turn feedback. The "생각 중" row (session prep / load / thinking phases + elapsed timer), the running tool
// card, the error card (다시 시도 / 새 세션으로 시도), agent warnings shown as warn notices, and agent logos on sidebar
// rows and palette results. Fixture mode only: Codex is tests/fixtures/acp/fakeAcpAgent.mjs, Claude is fakeQuery.
// FAKE_ACP_INIT_DELAY_MS makes every ACP session open take a moment, so the prep / load phases are observable.
import { expect, test, type Page } from '@playwright/test';
import {
  bootstrapState,
  chooseFixtureFolder,
  createSandbox,
  launch,
  menuShortcut,
  openDraft,
  pickAgent,
  screenshot,
  screenshotOf,
  sendMessage,
  threadById,
  type Launched,
  type Sandbox,
} from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;
let codexThreadId = '';

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox, { env: { FAKE_ACP_INIT_DELAY_MS: '1500' } });
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

const messages = (page: Page) => page.locator('.hc-messages');
const composer = (page: Page) => page.locator('.hc-composer');
const activity = (page: Page) => page.getByTestId('turn-activity');

test('thinking row: session prep, then 생각하는 중 with a running timer; the streaming cursor takes over', async () => {
  const { page } = run;
  const before = new Set((await bootstrapState(page)).threads.map((t) => t.id));
  await openDraft(page);
  await pickAgent(page, 'Codex');
  await chooseFixtureFolder(page, sandbox);
  await sendMessage(page, '/slow 3000');

  // The agent process is starting (initialize answers after 1.5s): the slot says so.
  await expect(activity(page)).toContainText('Codex 세션 준비 중…');
  await expect(activity(page)).toHaveAttribute('data-phase', 'preparing');
  // Session open (controls arrived): the agent thinks before its first tick, and the timer runs.
  await expect(activity(page)).toHaveAttribute('data-phase', 'thinking');
  await expect(activity(page)).toContainText('생각하는 중…');
  await expect(page.getByTestId('turn-elapsed')).toHaveText(/^[2-9]s$/);
  await screenshot(page, 'v11-thinking', SHOTS);

  codexThreadId = (await bootstrapState(page)).threads.find((t) => !before.has(t.id))!.id;
  // The first chunk replaces the row; the streaming text ends in the soft cursor.
  await expect(messages(page)).toContainText('tick 1');
  await expect(activity(page)).toHaveCount(0);
  await expect(messages(page).locator('.hc-msg-assistant--streaming .hc-cursor')).toBeVisible();
  // The header and the sidebar row carry the running pill meanwhile.
  await expect(page.locator('.hc-chat-header .hc-status--running')).toBeVisible();
  await expect(page.getByTestId('sidebar').locator('.hc-thread .hc-status--running')).toHaveCount(1);

  await composer(page).getByRole('button', { name: '정지' }).click();
  await expect(composer(page).getByRole('button', { name: '보내기' })).toBeVisible();
  await expect(messages(page).locator('.hc-cursor')).toHaveCount(0);
});

test('tool card: 실행 중… with its elapsed time, then the check settles in', async () => {
  const { page } = run;
  await sendMessage(page, '/slowtool 3000');
  const tool = messages(page).locator('.hc-tool').filter({ hasText: 'Run sleep fixture' }).last();
  await expect(tool).toHaveAttribute('data-state', 'running');
  await expect(tool.locator('.hc-tool__progress')).toContainText('실행 중…');
  await expect(tool.locator('.hc-tool__elapsed')).toHaveText(/^[1-9]s$/);
  // A running tool shows its own progress: no thinking row on top of it.
  await expect(activity(page)).toHaveCount(0);
  await screenshot(page, 'v11-tool-running', SHOTS);

  await expect(tool).toHaveAttribute('data-state', 'done');
  await expect(tool.locator('.hc-tool__status--settled')).toBeVisible();
  await expect(tool.locator('.hc-tool__progress')).toHaveCount(0);
  await expect(messages(page)).toContainText('slow tool done');
});

test('model metadata warning: a yellow notice, not part of the answer', async () => {
  const { page } = run;
  await sendMessage(page, '/warn');
  await expect(messages(page)).toContainText('warn done');
  const warning = messages(page).getByTestId('agent-warning').last();
  await expect(warning).toHaveClass(/hc-notice--warn/);
  await expect(warning).toContainText('모델 메타데이터를 찾지 못해');
  await expect(warning).toContainText('Model metadata for `gpt-6.1-sol` not found');
  await expect(messages(page).locator('.hc-msg-assistant').filter({ hasText: 'Model metadata' })).toHaveCount(0);
  await screenshot(page, 'v11-warning', SHOTS);
});

test('error card: explanation, raw details, 다시 시도 (loads the session again) and 새 세션으로 시도', async () => {
  const { page } = run;
  await sendMessage(page, '/crash');
  const cards = messages(page).getByTestId('error-card');
  const card = cards.last();
  await expect(card).toHaveAttribute('data-kind', 'crash');
  await expect(card).toContainText('Codex 프로세스 종료');
  await expect(card).toContainText('예기치 않게 종료되었습니다');
  await expect(card.getByTestId('error-raw')).toHaveCount(0);
  await card.getByRole('button', { name: '자세히 보기' }).click();
  await expect(card.getByTestId('error-raw')).toContainText('fatal: token [redacted]');
  expect(await page.content()).not.toContain('FAKESECRET');
  await expect(card.getByRole('button', { name: '메시지 복사' })).toBeVisible();
  // The details grew the card below the fold: bring its actions into view for the capture.
  await card.getByRole('button', { name: '메시지 복사' }).scrollIntoViewIfNeeded();
  await screenshot(page, 'v11-error-card', SHOTS);

  // 다시 시도: the same message again, in this thread; the crashed session is loaded back first.
  const bubbles = messages(page).locator('.hc-msg-user__bubble');
  const sent = await bubbles.count();
  await card.getByRole('button', { name: '다시 시도' }).click();
  await expect(bubbles).toHaveCount(sent + 1);
  await expect(bubbles.last()).toHaveText('/crash');
  await expect(activity(page)).toContainText('이전 대화 불러오는 중…');
  await expect(cards).toHaveCount(2);
  // Only the card that ended the latest turn offers the actions.
  await expect(cards.first().getByRole('button', { name: '다시 시도' })).toHaveCount(0);

  // 새 세션으로 시도: a new Codex thread in the same folder, started with the same message.
  const rows = page.getByTestId('sidebar').locator('.hc-thread');
  const threadsBefore = await rows.count();
  const idsBefore = new Set((await bootstrapState(page)).threads.map((t) => t.id));
  await cards.last().getByRole('button', { name: '새 세션으로 시도' }).click();
  await expect(rows).toHaveCount(threadsBefore + 1);
  await expect(messages(page).locator('.hc-msg-user__bubble')).toHaveCount(1);
  await expect(messages(page).locator('.hc-msg-user__bubble').first()).toHaveText('/crash');
  const created = (await bootstrapState(page)).threads.find((t) => !idsBefore.has(t.id))!;
  const original = await threadById(page, codexThreadId);
  expect(await threadById(page, created.id)).toMatchObject({ agent: 'codex', projectId: original?.['projectId'] });
  await expect(messages(page).getByTestId('error-card')).toHaveCount(1);
});

test('agent logos: sidebar rows (채팅 / 프로젝트 / 고정) and palette results carry their agent', async () => {
  const { page } = run;
  const sidebar = page.getByTestId('sidebar');

  // A Claude chat without a project lands in 채팅.
  await sidebar.getByTestId('sidebar-chats').getByRole('button', { name: '프로젝트 없이 새 채팅' }).click();
  await expect(page.getByTestId('draft')).toBeVisible();
  await sendMessage(page, '[text] logo check');
  const chatRow = sidebar.getByTestId('sidebar-chats').locator('.hc-thread').first();
  await expect(chatRow).toHaveAttribute('data-agent', 'claude-code');
  await expect(chatRow.locator('.hc-thread__glyph--agent img')).toHaveCount(1);

  // Project rows: every Codex thread shows the Codex mark.
  const codexRow = sidebar.locator('.hc-project .hc-thread[data-agent="codex"]').first();
  await expect(codexRow).toBeVisible();
  await expect(codexRow.locator('.hc-thread__glyph[data-agent="codex"] img')).toHaveCount(1);

  // Pinned: the logo stays in the leading slot; the pin itself is the hover action.
  const wrap = sidebar.locator('.hc-project .hc-thread-wrap').filter({ has: page.locator('.hc-thread[data-agent="codex"]') }).first();
  await wrap.hover();
  await wrap.locator('.hc-thread__action').first().click();
  const pinned = sidebar.getByRole('region', { name: '고정된 스레드' }).locator('.hc-thread');
  await expect(pinned).toHaveCount(1);
  await expect(pinned.first()).toHaveAttribute('data-agent', 'codex');
  await expect(pinned.first().locator('.hc-thread__glyph--agent img')).toHaveCount(1);
  await page.mouse.move(600, 400);
  await screenshotOf(page, sidebar, 'v11-sidebar-logos', SHOTS);

  // Every row has an agent (archived rows keep their own glyph but still say which agent ran them).
  const all = sidebar.locator('.hc-thread');
  const n = await all.count();
  for (let i = 0; i < n; i++) await expect(all.nth(i)).toHaveAttribute('data-agent', /^(claude-code|codex|hermes)$/);

  // ⌘K: thread results show the same marks.
  await menuShortcut(run.app, 'CmdOrCtrl+K');
  const palette = page.getByRole('dialog');
  await expect(palette.locator('.hc-palette__agent[data-agent="codex"]').first()).toBeVisible();
  await expect(palette.locator('.hc-palette__agent[data-agent="claude-code"]').first()).toBeVisible();
  await screenshot(page, 'v11-palette-logos', SHOTS);
  await page.keyboard.press('Escape');
});
