// Composer `/` picker (v14): Claude Code skills / commands scanned from a fake shared .claude (fixture mode reads
// `$HOPECODE_HOME/home/fixture-claude`, never the real ~/.claude), preview, completion and sending; Codex commands
// from the fixture ACP agent's `available_commands_update` (FAKE_ACP_COMMANDS=1). Headless, no real agent or API.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chooseFixtureFolder, createSandbox, launch, openDraft, pickAgent, screenshot, sendMessage, type Launched, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;

function writeFile(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function seedSharedClaude(home: string): void {
  const root = join(home, 'home', 'fixture-claude');
  writeFile(
    root,
    'skills/demo/SKILL.md',
    [
      '---',
      'name: demo',
      'description: 데모 스킬 — 주제를 받아 짧은 요약을 씁니다',
      'argument-hint: <주제>',
      '---',
      '',
      '# Demo skill',
      '',
      'Write a **short** summary of the topic.',
      '',
      '- step one',
      '- step two',
      '<script>window.__slashXss = 1</script>',
      '',
    ].join('\n'),
  );
  writeFile(root, 'commands/hello.md', '---\ndescription: 인사를 합니다\n---\nSay hello.\n');
}

test.beforeAll(async () => {
  sandbox = createSandbox();
  seedSharedClaude(sandbox.home);
  run = await launch(sandbox, { env: { FAKE_ACP_COMMANDS: '1' } });
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

const box = (page: Page) => page.locator('.hc-composer__textarea');
const menu = (page: Page) => page.getByTestId('slash-menu');
const option = (page: Page, name: string) => menu(page).getByRole('option', { name: new RegExp(`^/${name}\\b`) });

test('Claude draft: / lists scanned skills + commands, previews, completes and sends /demo args', async () => {
  const { page } = run;
  await openDraft(page);
  await chooseFixtureFolder(page, sandbox);

  await box(page).fill('/');
  await expect(menu(page)).toBeVisible();
  await expect(option(page, 'demo')).toContainText('user');
  await expect(option(page, 'hello')).toContainText('인사를 합니다');
  // Built-ins the SDK documents for headless sessions (no live session in a draft).
  await expect(option(page, 'compact')).toContainText('Claude 내장');

  // Fuzzy filter + preview of the active row (text only: the <script> line is never executed or rendered as HTML).
  await box(page).fill('/de');
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  await expect(option(page, 'demo')).toHaveAttribute('aria-selected', 'true');
  const preview = page.getByTestId('slash-preview');
  await expect(preview).toContainText('데모 스킬');
  await expect(preview).toContainText('<주제>');
  await expect(preview).toContainText('skills/demo/SKILL.md');
  await expect(preview.locator('h1')).toHaveText('Demo skill');
  await expect(preview.locator('strong')).toHaveText('short');
  expect(await page.evaluate(() => (window as unknown as { __slashXss?: number }).__slashXss)).toBeUndefined();
  await expect(preview.locator('script')).toHaveCount(0);
  await screenshot(page, 'v14-slash', SHOTS);

  // Escape dismisses; typing a new token opens it again; ↑↓ move the selection.
  await box(page).press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await box(page).fill('/');
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await box(page).press('ArrowDown');
  await expect(menu(page).getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await box(page).press('ArrowUp');

  // Enter on a command with an argument hint completes it; the arguments follow; Enter sends `/demo args`.
  await box(page).fill('/de');
  await box(page).press('Enter');
  await expect(box(page)).toHaveValue('/demo ');
  await expect(menu(page)).toHaveCount(0);
  await box(page).pressSequentially('hello world');
  await box(page).press('Enter');
  await expect(page.locator('.hc-messages .hc-msg-user__bubble').last()).toHaveText('/demo hello world');
  await expect(page.locator('.hc-messages')).toContainText('Slash command received: /demo hello world');
});

test('Claude thread: the live session list adds its built-ins; an argument-less command sends on Enter', async () => {
  const { page } = run;
  await box(page).fill('/');
  await expect(option(page, 'demo')).toBeVisible();
  // supportedCommands(): /context is a GUI built-in, /exit is terminal-only and stays hidden.
  await expect(option(page, 'context')).toContainText('Claude 내장');
  await expect(menu(page).getByRole('option', { name: /^\/exit\b/ })).toHaveCount(0);
  await box(page).fill('/hel');
  await box(page).press('Enter');
  await expect(page.locator('.hc-messages .hc-msg-user__bubble').last()).toHaveText('/hello');
  await expect(page.locator('.hc-messages')).toContainText('Slash command received: /hello');
  await expect(box(page)).toHaveValue('');
});

test('Codex: no commands before the session, then the agent-advertised list (available_commands_update)', async () => {
  const { page } = run;
  await openDraft(page);
  await pickAgent(page, 'Codex');
  await chooseFixtureFolder(page, sandbox);
  await box(page).fill('/');
  await expect(page.getByTestId('slash-empty')).toHaveText('세션이 시작되면 명령이 표시됩니다');
  await box(page).fill('');
  await sendMessage(page, 'hello codex');
  await expect(page.locator('.hc-messages')).toContainText('FAKE-ACP(codex): hello codex');

  await box(page).fill('/');
  await expect(option(page, 'review')).toContainText('Codex 내장');
  await expect(option(page, 'init')).toBeVisible();
  await box(page).fill('/rev');
  await expect(page.getByTestId('slash-preview')).toContainText('optional custom review instructions');
  await box(page).press('Tab');
  await expect(box(page)).toHaveValue('/review ');
  await box(page).pressSequentially('now');
  await box(page).press('Enter');
  await expect(page.locator('.hc-messages')).toContainText('FAKE-ACP(codex): /review now');

  // No input hint: Enter sends `/init` straight away.
  await box(page).fill('/ini');
  await box(page).press('Enter');
  await expect(page.locator('.hc-messages')).toContainText('FAKE-ACP(codex): /init');
});
