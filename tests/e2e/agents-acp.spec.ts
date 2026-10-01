// Codex / Hermes threads over ACP (plan 6: AC1-AC5, AC8, AC13 + /crash redaction). Fixture mode only: both agents
// are tests/fixtures/acp/fakeAcpAgent.mjs (profiles codex / hermes / noload); no real codex-acp or hermes runs.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  bootstrapState,
  chooseFixtureFolder,
  createSandbox,
  launch,
  openDraft,
  pickAgent,
  screenshot,
  sendMessage,
  threadById,
  type AgentName,
  type Launched,
  type Sandbox,
} from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

const messages = (page: Page) => page.locator('.hc-messages');
const composer = (page: Page) => page.locator('.hc-composer');

/** Draft -> agent -> fixture folder -> first message; returns the new thread id. */
async function startAgentThread(page: Page, agent: AgentName, text: string): Promise<string> {
  const before = new Set((await bootstrapState(page)).threads.map((t) => t.id));
  await openDraft(page);
  await pickAgent(page, agent);
  await chooseFixtureFolder(page, sandbox);
  await sendMessage(page, text);
  await expect(page.locator('.hc-messages .hc-msg-user__bubble').last()).toHaveText(text);
  const created = (await bootstrapState(page)).threads.find((t) => !before.has(t.id));
  expect(created).toBeDefined();
  return created!.id;
}

/** Sends `text` and returns the JSON of the fixture's new `WHOAMI ` / `CONFIG ` reply. */
async function report(page: Page, text: string, tag: 'WHOAMI' | 'CONFIG'): Promise<Record<string, unknown>> {
  const replies = messages(page).getByText(new RegExp(`^${tag} \\{`));
  const before = await replies.count();
  await sendMessage(page, text);
  await expect(replies).toHaveCount(before + 1);
  const body = (await replies.last().textContent()) ?? '';
  return JSON.parse(body.slice(body.indexOf('{'))) as Record<string, unknown>;
}

async function selectThread(page: Page, title: string): Promise<void> {
  await page.getByTestId('sidebar').locator('.hc-thread').filter({ hasText: title }).first().click();
  await expect(page.locator('.app__thread-name')).toHaveText(title);
}

/** Shared ACP scenarios: tool card, diff (+ Changes panel), plan card, permission allow / deny, Stop. */
async function runScenarios(page: Page, profile: 'codex' | 'hermes'): Promise<void> {
  // /tool: pending -> in_progress -> completed with text content.
  await sendMessage(page, '/tool');
  await expect(messages(page)).toContainText('tool done');
  const tool = messages(page).locator('.hc-tool').filter({ hasText: 'Read README.md' }).last();
  await expect(tool.locator('.hc-tool__status--ok')).toBeVisible();

  // /diff: the fixture writes fake-acp-edit.txt in the worktree and reports the diff.
  await sendMessage(page, '/diff');
  await expect(messages(page)).toContainText('edit done');
  const edit = messages(page).locator('.hc-tool').filter({ hasText: 'fake-acp-edit.txt' }).last();
  await edit.locator('.hc-tool__header').click();
  await expect(edit.locator('.hc-diff__row--add').filter({ hasText: 'fake acp edit' })).toHaveCount(1);
  const changesToggle = page.getByRole('toolbar', { name: '스레드 도구' }).getByRole('button', { name: '변경사항 패널' });
  await changesToggle.click();
  await expect(page.getByTestId('changes-panel').locator('.hc-changes__file[data-path="fake-acp-edit.txt"]')).toBeVisible();
  await changesToggle.click();

  // /plan: a TodoWrite-like card with the three entries.
  await sendMessage(page, '/plan');
  await expect(messages(page)).toContainText('plan done');
  await expect(messages(page).locator('.hc-tool').filter({ hasText: '3 items' }).last()).toBeVisible();

  // /permission -> 허용: the agent receives an allow option.
  await sendMessage(page, '/permission');
  const card = page.locator('.hc-permission');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('permission-agent-options')).toContainText(profile === 'hermes' ? 'Allow for session' : 'Always allow');
  // Both fixture agents offer reject_once, so 거부 needs no "the whole turn may be cancelled" caption.
  await expect(card.getByTestId('permission-deny-caption')).toHaveCount(0);
  if (profile === 'hermes') {
    await expect(card.getByTestId('permission-session-caption')).toContainText('Allow for session');
  }
  if (profile === 'codex') await screenshot(page, 'v7-codex-thread', SHOTS);
  await card.getByRole('button', { name: '허용', exact: true }).click();
  await expect(messages(page)).toContainText('permission: allow_once');
  await expect(card).toHaveCount(0);

  // /permission -> 거부: the tool fails and the agent receives its reject option.
  await sendMessage(page, '/permission');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '거부', exact: true }).click();
  await expect(messages(page)).toContainText(profile === 'hermes' ? 'permission: deny' : 'permission: reject_once');

  // /slow -> 정지: session/cancel ends the turn; the ticks stop.
  await sendMessage(page, '/slow');
  await expect(messages(page)).toContainText('tick 3');
  await composer(page).getByRole('button', { name: '정지' }).click();
  await expect(composer(page).getByRole('button', { name: '정지' })).toHaveCount(0);
  await expect(composer(page).getByRole('button', { name: '보내기' })).toBeVisible();
  const ticks = async () => ((await messages(page).textContent()) ?? '').match(/tick \d+/g)?.length ?? 0;
  const stopped = await ticks();
  await page.waitForTimeout(1_000);
  expect(await ticks()).toBe(stopped);
}

test('agent menu lists Claude Code, Codex and Hermes (fixture logins: all usable)', async () => {
  const { page } = run;
  await openDraft(page);
  await page.getByTestId('draft').locator('.hc-chip--agent').click();
  const menu = page.getByRole('menu', { name: '에이전트' });
  for (const name of ['Claude Code', 'Codex', 'Hermes']) {
    const row = menu.getByRole('menuitemradio', { name: new RegExp(`^${name}`) });
    await expect(row).toBeVisible();
    await expect(row).toBeEnabled();
  }
  await screenshot(page, 'v7-agent-menu', SHOTS);
  await page.keyboard.press('Escape');
});

test('codex: first send creates a worktree and streams; spawn -c carries GPT-6-Sol / high and the default permission', async () => {
  const { page } = run;
  ids['codex'] = await startAgentThread(page, 'Codex', 'hello codex');
  await expect(messages(page)).toContainText('FAKE-ACP(codex): hello codex');
  const thread = await threadById(page, ids['codex']);
  expect(thread).toMatchObject({ agent: 'codex', model: 'gpt-6-sol', effort: 'high', permissionMode: 'default' });
  expect((thread!['worktree'] as { branch: string }).branch).toMatch(/^hopecode\//);
  expect((thread!['cwd'] as string).startsWith(`${sandbox.home}/home/worktrees/`)).toBe(true);

  // Composer: Codex model chip + the app permission chip; no Claude account chip.
  // Live thread: the label is the agent's own option name (the fixture names options by value).
  await expect(composer(page).locator('.hc-chip--model')).toContainText(/gpt-6-sol/i);
  await expect(composer(page).locator('.hc-chip--model')).toContainText('High');
  await expect(composer(page).getByRole('button', { name: '권한: 기본' })).toBeVisible();
  // Codex v1 shows no limit meters (ctx / model only).
  await expect(page.getByTestId('statusline')).toHaveAttribute('data-mode', 'basic');

  const who = await report(page, '[whoami]', 'WHOAMI');
  expect(who).toMatchObject({
    profile: 'codex',
    model: 'gpt-6-sol',
    reasoning_effort: 'high',
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write',
  });
  expect(who['args']).toMatchObject({ model: 'gpt-6-sol', model_reasoning_effort: 'high' });
  ids['codexSession'] = who['sessionId'] as string;
});

test('codex: tool card, diff, plan, permission allow / deny and Stop (session/cancel)', async () => {
  await runScenarios(run.page, 'codex');
});

test('codex: 전체 액세스 needs the confirmation; declined keeps 기본', async () => {
  const { page, app } = run;
  await app.evaluate(() => {
    globalThis.__hopecodeFixtureBypassAnswer = false;
  });
  const perm = composer(page).getByRole('button', { name: /^권한:/ });
  await perm.click();
  await page.getByRole('menu', { name: '권한' }).getByRole('menuitemradio', { name: /^전체 액세스/ }).click();
  // Nothing is broadcast for a declined warning: give the IPC round trip time, then the chip must still say 기본.
  await page.waitForTimeout(500);
  await expect(perm).toHaveAttribute('aria-label', '권한: 기본');
  expect(await threadById(page, ids['codex'])).toMatchObject({ permissionMode: 'default' });
});

test('codex: a draft with 전체 액세스 (confirmed) spawns approval_policy=never + danger-full-access', async () => {
  const { page, app } = run;
  await app.evaluate(() => {
    globalThis.__hopecodeFixtureBypassAnswer = true;
  });
  await openDraft(page);
  await pickAgent(page, 'Codex');
  const perm = page.getByTestId('draft').locator('.hc-chip--perm');
  await perm.click();
  await page.getByRole('menu', { name: '권한' }).getByRole('menuitemradio', { name: /^전체 액세스/ }).click();
  await chooseFixtureFolder(page, sandbox);
  const who = await report(page, '[whoami] full access', 'WHOAMI');
  expect(who).toMatchObject({ approval_policy: 'never', sandbox_mode: 'danger-full-access', modeId: 'full-access' });
  await expect(composer(page).getByRole('button', { name: /^권한:/ })).toHaveAttribute('aria-label', '권한: 전체 액세스');
});

test('codex: 계획 maps to sandbox_mode=read-only', async () => {
  const { page } = run;
  await openDraft(page);
  await pickAgent(page, 'Codex');
  await page.getByTestId('draft').locator('.hc-chip--perm').click();
  await page.getByRole('menu', { name: '권한' }).getByRole('menuitemradio', { name: /^계획/ }).click();
  await chooseFixtureFolder(page, sandbox);
  expect(await report(page, '[whoami] plan mode', 'WHOAMI')).toMatchObject({ approval_policy: 'on-request', sandbox_mode: 'read-only', modeId: 'read-only' });
});

test('codex: /crash ends with a redacted error notice (no token on screen)', async () => {
  const { page } = run;
  ids['crash'] = await startAgentThread(page, 'Codex', '/crash');
  const notice = messages(page).locator('.hc-notice--error').last();
  await expect(notice).toContainText('프로세스가 종료되었습니다');
  await expect(notice).toContainText('fatal: token [redacted]');
  const html = await page.content();
  expect(html).not.toContain('sk-FAKESECRET');
  expect(html).not.toContain('FAKESECRET0123456789');
});

test('hermes: system default model (reported by the agent), ACP mode chip, scenarios, usage meters', async () => {
  const { page } = run;
  await openDraft(page);
  await pickAgent(page, 'Hermes');
  const draft = page.getByTestId('draft');
  await expect(draft.getByTestId('system-model-tag')).toHaveText('시스템 기본값');
  await expect(draft.locator('.hc-chip--perm')).toHaveCount(0);
  await chooseFixtureFolder(page, sandbox);
  await sendMessage(page, 'hello hermes');
  await expect(messages(page)).toContainText('FAKE-ACP(hermes): hello hermes');
  const created = (await bootstrapState(page)).threads.find((t) => t.title === 'hello hermes')!;
  ids['hermes'] = created.id;
  expect(await threadById(page, created.id)).toMatchObject({ agent: 'hermes', model: '', effort: null });
  expect(created.worktree?.branch).toMatch(/^hopecode\//);

  await expect(composer(page).getByTestId('system-model-tag')).toHaveText('시스템 기본값 · og/deepseek-fixture');
  const mode = composer(page).getByRole('button', { name: /^모드:/ });
  await expect(mode).toHaveAttribute('aria-label', '모드: Ask before edits');
  // The selected Hermes thread polls `hermes usage` (fixture: two windows).
  await expect(page.getByTestId('statusline')).toHaveAttribute('data-mode', 'agent-usage');
  await expect(page.getByTestId('statusline').locator('.hc-statusline__segment-wrap')).toHaveCount(2);

  // set_mode through the chip.
  await mode.click();
  await page.getByRole('menu', { name: '에이전트 모드' }).getByRole('menuitemradio', { name: /^Accept edits/ }).click();
  await expect(mode).toHaveAttribute('aria-label', '모드: Accept edits');
  // The app never sets Hermes' model / effort (no set_config_option).
  expect(await report(page, '/config', 'CONFIG')).toMatchObject({ profile: 'hermes', modeId: 'accept_edits', configSets: [] });
  await screenshot(page, 'v7-hermes-thread', SHOTS);

  await runScenarios(page, 'hermes');
});

test('restart: the Codex thread resumes its ACP session through session/load (no replayed duplicates)', async () => {
  await run.app.close();
  run = await launch(sandbox);
  const { page } = run;
  await selectThread(page, 'hello codex');
  const bubbles = page.locator('.hc-messages .hc-msg-user__bubble');
  await expect(bubbles.first()).toHaveText('hello codex');
  const before = await bubbles.count();
  const who = await report(page, '[whoami] after restart', 'WHOAMI');
  expect(who['sessionId']).toBe(ids['codexSession']);
  // load replays the whole conversation; the app drops it instead of rendering it twice.
  await expect(bubbles).toHaveCount(before + 1);
  await expect(messages(page).getByText('FAKE-ACP(codex): hello codex')).toHaveCount(1);
  await expect(messages(page)).not.toContainText('새 세션으로 시작했습니다');
  expect(existsSync(join(sandbox.home, 'home', 'fake-acp', `${ids['codexSession']}.json`))).toBe(true);
});

test('restart with an agent without session/load: a new session and a clear notice', async () => {
  await run.app.close();
  run = await launch(sandbox, { env: { HOPECODE_FIXTURE_CODEX_PROFILE: 'noload' } });
  const { page } = run;
  await selectThread(page, 'hello codex');
  const who = await report(page, '[whoami] noload', 'WHOAMI');
  expect(who['profile']).toBe('noload');
  expect(who['sessionId']).not.toBe(ids['codexSession']);
  await expect(messages(page).locator('.hc-notice').filter({ hasText: '새 세션으로 시작했습니다' })).toBeVisible();
});
