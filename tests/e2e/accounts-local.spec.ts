// Local agent logins on the Accounts page (plan 2.9, AC6 / AC7 / AC1). HOPECODE_FIXTURE_LOCAL_CLAUDE=1 makes the
// fixture LocalAuthService report a logged-in local Claude, enrolled as the "로컬 (기본)" pool account whose config
// dir is $HOPECODE_HOME/home/fake-claude (never the real ~/.claude). Codex / Hermes report fixture logins.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  createSandbox,
  launch,
  openDraft,
  openFromMore,
  screenshot,
  type Launched,
  type Sandbox,
} from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;
let fakeClaude = '';
const MARKER = '{"fixture":"local claude login"}\n';

test.beforeAll(async () => {
  sandbox = createSandbox();
  // Stand-in for the user's ~/.claude: it must survive "풀에서 제외".
  fakeClaude = join(sandbox.home, 'home', 'fake-claude');
  mkdirSync(fakeClaude, { recursive: true });
  writeFileSync(join(fakeClaude, '.credentials-marker.json'), MARKER);
  run = await launch(sandbox, { env: { HOPECODE_FIXTURE_LOCAL_CLAUDE: '1' }, poolSize: 4 });
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

/** Nothing token-like may reach the DOM (fixture credentials, JWT / API key shapes). */
async function expectNoSecrets(page: Page): Promise<void> {
  const html = await page.content();
  for (const needle of ['accessToken', 'access_token', 'refresh_token', 'id_token', 'sk-', 'eyJ']) {
    expect(html, needle).not.toContain(needle);
  }
}

test('Accounts: one section per agent with the "이 Mac에서 감지됨" card', async () => {
  const { page } = run;
  await openFromMore(page, '계정');
  await expect(page.locator('.hc-accounts-page')).toBeVisible();
  for (const agent of ['claude-code', 'codex', 'hermes']) {
    const section = page.getByTestId(`agent-section-${agent}`);
    await expect(section).toBeVisible();
    await expect(section.getByTestId(`local-auth-${agent}`)).toContainText('이 Mac에서 감지됨');
    await expect(section.getByTestId(`local-auth-${agent}`)).toHaveAttribute('data-state', 'logged-in');
    await expect(section.getByTestId(`local-auth-recheck-${agent}`)).toBeVisible();
  }
  await expect(page.getByTestId('local-auth-claude-code')).toContainText('local@fixture.test');
  await expect(page.getByTestId('local-auth-codex')).toContainText('codex@fixture.test');
  await expect(page.getByTestId('local-auth-codex')).toContainText(/plus/i);
  await expect(page.getByTestId('local-auth-hermes')).toContainText('fixture-provider');
  await page.mouse.move(10, 700);
  await screenshot(page, 'v7-accounts-agents', SHOTS);
  await expectNoSecrets(page);
});

test('the local Claude login is a "로컬 (기본)" pool account with the pool toggle on', async () => {
  const { page } = run;
  const claude = page.getByTestId('agent-section-claude-code');
  await expect(claude.getByTestId('local-claude-toggle')).toHaveAttribute('aria-checked', 'true');
  const local = claude.locator('.hc-acct-row').filter({ hasText: '로컬 (기본)' });
  await expect(local).toHaveCount(1);
  await expect(page.getByTestId('statusline')).toContainText('/4 avail');
  const accounts = (await page.evaluate(() => window.hopecode.invoke('app:bootstrap'))) as {
    accounts: { source?: string; configDir: string }[];
  };
  const entry = accounts.accounts.find((a) => a.source === 'local-default');
  expect(entry?.configDir).toBe(fakeClaude);
});

test('"풀에서 제외" drops it from the pool and leaves the login folder alone; the toggle brings it back', async () => {
  const { page } = run;
  const claude = page.getByTestId('agent-section-claude-code');
  const local = claude.locator('.hc-acct-row').filter({ hasText: '로컬 (기본)' });
  await local.getByRole('button', { name: /풀에서 제외$/ }).click();
  await expect(local).toContainText('~/.claude)은 삭제하지 않습니다');
  await local.locator('.hc-acct-row__confirm').getByRole('button', { name: '풀에서 제외' }).click();
  await expect(claude.locator('.hc-acct-row').filter({ hasText: '로컬 (기본)' })).toHaveCount(0);
  await expect(claude.getByTestId('local-claude-toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('statusline')).toContainText('/3 avail');
  expect(existsSync(fakeClaude)).toBe(true);
  expect(readFileSync(join(fakeClaude, '.credentials-marker.json'), 'utf8')).toBe(MARKER);

  await claude.getByTestId('local-claude-toggle').click();
  await expect(claude.getByTestId('local-claude-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(claude.locator('.hc-acct-row').filter({ hasText: '로컬 (기본)' })).toHaveCount(1);
  await expectNoSecrets(page);
});

test('agents that are not installed / not logged in are disabled in the agent menu with the reason', async () => {
  await run.app.close();
  run = await launch(sandbox, {
    env: { HOPECODE_FIXTURE_LOCAL_CLAUDE: '1', HOPECODE_FIXTURE_AGENTS: 'codex:logged-out,hermes:not-installed' },
    poolSize: 4,
  });
  const { page } = run;
  await openDraft(page);
  await page.getByTestId('draft').locator('.hc-chip--agent').click();
  const menu = page.getByRole('menu', { name: '에이전트' });
  await expect(menu.getByRole('menuitemradio', { name: /^Claude Code/ })).toBeEnabled();
  const codex = menu.getByRole('menuitemradio', { name: /^Codex/ });
  const hermes = menu.getByRole('menuitemradio', { name: /^Hermes/ });
  await expect(codex).toBeDisabled();
  await expect(codex).toContainText('로그인 필요');
  await expect(hermes).toBeDisabled();
  await expect(hermes).toContainText('설치되지 않음');
  await expect(menu.getByRole('menuitem', { name: '설치·로그인 상태 다시 확인' })).toBeVisible();
  await screenshot(page, 'v7-agent-menu-unavailable', SHOTS);
  await page.keyboard.press('Escape');

  await openFromMore(page, '계정');
  await expect(page.getByTestId('local-auth-codex')).toHaveAttribute('data-state', 'logged-out');
  await expect(page.getByTestId('local-auth-hermes')).toHaveAttribute('data-state', 'not-installed');
  await expectNoSecrets(page);
});
