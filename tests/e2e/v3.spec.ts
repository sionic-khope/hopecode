// v3: profile row + menu, shortcuts / about modals, settings (persisted and applied by main), agent picker,
// suggested prompts, reduced motion, changes panel after a fixture Edit, commit / merge / Push + PR (fixture
// publisher: nothing leaves the machine), bottom terminal, command palette, code block copy, Fable 5.1 model menu.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  bottomTerminal,
  bootstrapState,
  chooseFixtureFolder,
  createSandbox,
  launch,
  menuShortcut,
  openDraft,
  openFromMore,
  screenshot,
  screenshotOf,
  sendMessage,
  startThread,
  type Launched,
  type Sandbox,
} from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;
let origin: string;

test.beforeAll(async () => {
  sandbox = createSandbox();
  // A local bare repo as `origin` so "Push + PR" has a target; the fixture publisher never pushes anywhere.
  origin = mkdtempSync(join(tmpdir(), 'hopecode-e2e-origin-'));
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: sandbox.project });
  run = await launch(sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
  if (origin) rmSync(origin, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('draft: agent chip, greeting, suggested prompts fill the composer', async () => {
  const { page } = run;
  const draft = page.getByTestId('draft');
  await expect(draft).toBeVisible();
  const agent = draft.locator('.hc-chip--agent');
  await expect(agent).toHaveAttribute('aria-label', '에이전트: Claude Code');
  const cards = draft.getByTestId('suggestion');
  await expect(cards).toHaveCount(4);
  await chooseFixtureFolder(page, sandbox);
  await page.mouse.move(10, 700);
  await screenshot(page, 'v3-draft', SHOTS);

  await cards.nth(2).click();
  const box = page.locator('.hc-composer__textarea');
  await expect(box).toHaveValue('테스트가 부족한 핵심 로직을 찾아 단위 테스트를 추가해 주세요.');
  await expect(box).toBeFocused();
  await box.fill('');

  await agent.click();
  const menu = page.getByRole('menu', { name: '에이전트' });
  await expect(menu.getByRole('menuitemradio', { name: /^Claude Code/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
});

test('reduced motion collapses every motion token (popover animation included)', async () => {
  const { page } = run;
  const token = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--motion-2').trim());
  expect(await token()).toBe('200ms');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await token()).toBe('0ms');
  await page.getByTestId('draft').locator('.hc-chip--perm').click();
  const duration = await page.locator('.hc-popover').evaluate((el) => getComputedStyle(el).animationDuration);
  expect(duration).toBe('0s');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await token()).toBe('200ms');
});

test('profile row: account, plan and an upward menu with the pool summary', async () => {
  const { page } = run;
  const row = page.getByTestId('profile-row');
  await expect(row).toContainText('Work');
  await expect(row).toContainText('Max');
  await screenshotOf(page, page.getByTestId('sidebar'), 'v3-sidebar', SHOTS);
  await row.click();
  const menu = page.getByRole('menu', { name: '프로필' });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('work@example.com');
  await expect(menu).toContainText('계정 3개 · 2개 사용 가능');
  // Pages (계정, 사용량, 설정, 단축키, 앱 정보) live in the nav's 더보기 menu; the profile menu does not repeat them.
  await expect(menu.getByRole('menuitem')).toHaveText([/^계정 추가/, /^로그 폴더 열기/, /^Hopecode 종료/]);
  // The menu opens above the row.
  const menuBox = await page.locator('.hc-popover:has(.hc-mnu)').boundingBox();
  const rowBox = await row.boundingBox();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(rowBox!.y + 1);
  await screenshot(page, 'v3-profile-menu', SHOTS);

  // 로그 폴더 열기 is a no-op in e2e (never opens Finder) and keeps the app usable.
  await menu.getByRole('menuitem', { name: /^로그 폴더 열기/ }).click();
  await expect(menu).toHaveCount(0);
});

test('키보드 단축키 and 앱 정보 modals', async () => {
  const { page } = run;
  await openFromMore(page, '키보드 단축키');
  const shortcuts = page.getByRole('dialog', { name: '키보드 단축키' });
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts).toContainText('명령 팔레트');
  await expect(shortcuts).toContainText('변경사항 패널 열기/닫기');
  await expect(shortcuts).toContainText('하단 터미널 열기/닫기');
  await screenshot(page, 'v3-shortcuts', SHOTS);
  await page.keyboard.press('Escape');
  await expect(shortcuts).toHaveCount(0);

  await openFromMore(page, '앱 정보');
  const about = page.getByRole('dialog', { name: 'Hopecode' });
  await expect(about).toBeVisible();
  await expect(about.getByRole('definition').nth(1)).toHaveText(/^\d+\.\d+\.\d+/); // CLI version
  await expect(about).toContainText('Agent SDK');
  await expect(about).toContainText('0.3.282');
  await screenshot(page, 'v3-about', SHOTS);
  await about.getByRole('button', { name: '확인' }).click();
  await expect(about).toHaveCount(0);
});

test('settings: changes persist in main and apply to the next new chat (worktree off -> project folder)', async () => {
  const { page } = run;
  await openFromMore(page, '설정');
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('region', { name: '공유 설정' })).toContainText('CLAUDE.md');
  await screenshot(page, 'v3-settings', SHOTS);

  await settings.getByRole('radiogroup', { name: '기본 effort' }).getByRole('radio', { name: 'High', exact: true }).click();
  await settings.getByRole('switch', { name: '새 스레드마다 worktree 만들기' }).click();
  await settings.getByRole('switch', { name: '한도 도달 시 자동 전환' }).click();
  const range = settings.getByRole('slider', { name: '사용량 조회 간격 (초)' });
  await range.focus();
  await page.keyboard.press('ArrowRight');
  await expect(settings.locator('.hc-settings__range-value')).toHaveText('2분');

  await expect
    .poll(async () => {
      const s = (await page.evaluate(() => window.hopecode.invoke('app:bootstrap'))) as { settings: Record<string, unknown> };
      return s.settings;
    })
    .toMatchObject({ defaultEffort: 'high', useWorktree: false, autoSwitchAccounts: false, usagePollIntervalSec: 120 });
  // Persisted to state.json (debounced save).
  await expect
    .poll(() => {
      try {
        return JSON.parse(readFileSync(join(sandbox.home, 'userData', 'state.json'), 'utf8')).settings.useWorktree;
      } catch {
        return undefined;
      }
    })
    .toBe(false);

  // The next new chat starts with the defaults, and main creates it in the project folder itself.
  await openDraft(page);
  await expect(page.getByTestId('draft').locator('.hc-chip--model')).toContainText('High');
  await chooseFixtureFolder(page, sandbox);
  await sendMessage(page, '[text] worktree 없이 작업');
  await expect(page.locator('.hc-messages')).toContainText('Streaming reply from the fixture session.');
  const { threads } = await bootstrapState(page);
  const direct = threads.find((t) => t.title === '[text] worktree 없이 작업');
  expect(direct?.cwd).toBe(sandbox.project);
  expect(direct?.worktree).toBeUndefined();
  expect(direct?.effort).toBe('high');
  expect((direct as unknown as { agent: string }).agent).toBe('claude-code');
  // The agent is saved with the thread.
  await expect
    .poll(() => {
      try {
        const state = JSON.parse(readFileSync(join(sandbox.home, 'userData', 'state.json'), 'utf8'));
        return state.threads.find((t: { id: string }) => t.id === direct!.id)?.agent;
      } catch {
        return undefined;
      }
    })
    .toBe('claude-code');

  // Back to worktrees (and automatic switching) for the rest of the run.
  await openFromMore(page, '설정');
  await page.getByTestId('settings').getByRole('switch', { name: '새 스레드마다 worktree 만들기' }).click();
  await page.getByTestId('settings').getByRole('switch', { name: '한도 도달 시 자동 전환' }).click();
  await page
    .getByTestId('settings')
    .getByRole('radiogroup', { name: '기본 effort' })
    .getByRole('radio', { name: '자동' })
    .click();
  await expect
    .poll(async () => ((await page.evaluate(() => window.hopecode.invoke('app:bootstrap'))) as { settings: { useWorktree: boolean } }).settings.useWorktree)
    .toBe(true);
});

test('changes panel lists the file the fixture Edit changed, with its diff', async () => {
  const { page } = run;
  await startThread(page, sandbox, 'README 인사말을 바꿔 주세요');
  const permission = page.locator('.hc-permission');
  await expect(permission).toBeVisible();
  await screenshot(page, 'v3-conversation-permission', SHOTS);
  await permission.getByRole('button', { name: '허용', exact: true }).click();
  await expect(page.locator('.hc-messages')).toContainText('Done. The greeting now says "Hello Hopecode".');
  await page.locator('.hc-tool').filter({ hasText: 'Edit' }).locator('.hc-tool__header').click();
  await expect(page.locator('.hc-tool .hc-diff__row--add')).toContainText('Hello Hopecode');
  await page.mouse.move(10, 700);
  await screenshot(page, 'v3-conversation', SHOTS);

  const toolbar = page.getByRole('toolbar', { name: '스레드 도구' });
  await expect(toolbar).toBeVisible();
  await screenshotOf(page, page.locator('.app__titlebar--chat'), 'v3-toolbar', SHOTS);
  await toolbar.getByRole('button', { name: '변경사항 패널' }).click();
  const panel = page.getByTestId('changes-panel');
  await expect(panel).toBeVisible();
  const file = panel.locator('.hc-changes__file[data-path="README.md"]');
  await expect(file).toBeVisible();
  await expect(panel.locator('.hc-changes__badge--M')).toBeVisible();
  await file.click();
  await expect(panel.locator('.hc-diff__row--add')).toContainText('Hello Hopecode');
  await page.mouse.move(10, 700);
  await screenshot(page, 'v3-changes-panel', SHOTS);
});

test('commit (auto message), then merge into the project branch', async () => {
  const { page } = run;
  const { threads } = await bootstrapState(page);
  const thread = threads.find((t) => t.title === 'README 인사말을 바꿔 주세요')!;
  await page.getByRole('toolbar', { name: '스레드 도구' }).getByRole('button', { name: '환경' }).click();
  await page.getByRole('dialog', { name: '환경' }).getByRole('button', { name: '커밋 또는 푸시' }).click();
  const pop = page.getByRole('dialog', { name: '커밋' });
  await expect(pop).toBeVisible();
  await pop.getByRole('button', { name: '자동 생성' }).click();
  const message = pop.getByRole('textbox', { name: '커밋 메시지' });
  await expect(message).toHaveValue(/README\.md 수정/);
  await screenshot(page, 'v3-commit', SHOTS);
  await pop.getByRole('button', { name: '커밋', exact: true }).click();
  await expect(pop.getByRole('status')).toContainText('커밋했습니다');
  expect(git(thread.worktree!.path, 'log', '-1', '--format=%s')).toBe('README.md 수정');
  expect(git(thread.worktree!.path, 'status', '--porcelain')).toBe('');

  await pop.getByRole('button', { name: /원래 브랜치에 병합/ }).click();
  const confirm = page.getByRole('dialog', { name: '원래 브랜치에 병합할까요?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(thread.worktree!.branch);
  await confirm.getByRole('button', { name: '병합', exact: true }).click();
  await expect(confirm).toContainText('병합했습니다');
  expect(readFileSync(join(sandbox.project, 'README.md'), 'utf8')).toContain('Hello Hopecode');
  await confirm.locator('.hc-modal__actions').getByRole('button', { name: '닫기' }).click();
});

test('Push + PR goes through a confirm naming the remote and branches (fixture publisher)', async () => {
  const { page } = run;
  const toolbar = page.getByRole('toolbar', { name: '스레드 도구' });
  // From the commit popover...
  await toolbar.getByRole('button', { name: '환경' }).click();
  await page.getByRole('dialog', { name: '환경' }).getByRole('button', { name: '커밋 또는 푸시' }).click();
  const pop = page.getByRole('dialog', { name: '커밋' });
  const pushItem = pop.getByRole('button', { name: /Push \+ PR 만들기/ });
  await expect(pushItem).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  // ...and straight from the environment popover's 풀 리퀘스트 만들기.
  await toolbar.getByRole('button', { name: '환경' }).click();
  await page.getByRole('dialog', { name: '환경' }).getByRole('button', { name: '풀 리퀘스트 만들기' }).click();
  const confirm = page.getByRole('dialog', { name: 'Push하고 PR을 만들까요?' });
  await expect(confirm).toContainText('origin');
  await expect(confirm).toContainText('main');
  await screenshot(page, 'v3-push-pr-confirm', SHOTS);
  await confirm.getByRole('button', { name: 'Push + PR 만들기' }).click();
  await expect(confirm.locator('code.hc-commit__url')).toHaveText('https://github.com/example/hopecode-fixture/pull/1');
  await confirm.locator('.hc-modal__actions').getByRole('button', { name: '닫기' }).click();
  // Nothing reached the bare origin: the fixture publisher records instead of pushing.
  expect(git(origin, 'branch', '--list')).toBe('');
});

test('terminal docks under the conversation (⌘J); ⌘⇧D opens 변경사항 beside it', async () => {
  const { page } = run;
  const app = page.locator('.app');
  // Earlier specs may leave 변경사항 open: start with only the terminal.
  if (await app.evaluate((el) => el.classList.contains('app--panel-open'))) await menuShortcut(run.app, 'CmdOrCtrl+Shift+D');
  await expect(app).toHaveClass(/app--panel-closed/);
  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(app).toHaveClass(/app--terminal-open/);
  await expect(bottomTerminal(page).locator('.xterm')).toBeVisible();
  // No tab strip anywhere: the right panel carries only 변경사항.
  await expect(page.getByRole('radiogroup', { name: '패널' })).toHaveCount(0);
  await expect(app).toHaveClass(/app--panel-closed/);
  await menuShortcut(run.app, 'CmdOrCtrl+Shift+D');
  await expect(page.getByTestId('changes-panel')).toBeVisible();
  // Opening 변경사항 leaves the terminal where it is.
  await expect(app).toHaveClass(/app--terminal-open/);
  await expect(bottomTerminal(page).locator('.xterm')).toBeVisible();
  await menuShortcut(run.app, 'CmdOrCtrl+Shift+D');
  await expect(app).toHaveClass(/app--panel-closed/);
  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(app).toHaveClass(/app--terminal-closed/);
});

test('command palette (⌘K): search, then run a command and jump to a thread', async () => {
  const { page } = run;
  await menuShortcut(run.app, 'CmdOrCtrl+K');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await expect(page.getByRole('combobox', { name: '명령 검색' })).toBeFocused();
  await page.keyboard.type('ㅅㅈ');
  await expect(palette.getByRole('option').first()).toContainText('설정');
  await screenshot(page, 'v3-palette', SHOTS);
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('settings')).toBeVisible();

  await menuShortcut(run.app, 'CmdOrCtrl+K');
  await expect(page.getByRole('combobox', { name: '명령 검색' })).toBeFocused();
  await page.keyboard.type('README 인사말');
  await expect(palette.getByRole('option').first()).toContainText('README 인사말을 바꿔 주세요');
  await page.keyboard.press('Enter');
  await expect(page.locator('.app__thread-name')).toHaveText('README 인사말을 바꿔 주세요');
});

test('code block: language label and copy (clipboard stubbed, the real one is untouched)', async () => {
  const { page } = run;
  await sendMessage(page, '[code] 인사 함수');
  const block = page.locator('.hc-code').last();
  await expect(block).toBeVisible();
  await expect(block.locator('.hc-code__lang')).toHaveText('ts');
  await page.evaluate(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Clipboard.prototype.writeText = async (text: string) => {
      w.__copied.push(text);
    };
  });
  await block.getByRole('button', { name: '코드 복사' }).click();
  await expect(block.getByRole('button', { name: '복사됨' })).toBeVisible();
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied).toEqual(['export function greet(name: string): string {\n  return `Hello ${name}`;\n}']);
});

test('user message: 편집해서 다시 보내기 puts the text back in the composer; thread title renames in place', async () => {
  const { page } = run;
  const bubble = page.locator('.hc-msg-user').filter({ hasText: '[code] 인사 함수' });
  await bubble.hover();
  await bubble.getByRole('button', { name: '편집해서 다시 보내기' }).click();
  await expect(page.locator('.hc-composer__textarea')).toHaveValue('[code] 인사 함수');
  await page.locator('.hc-composer__textarea').fill('');

  await page.locator('.app__thread-name').click();
  const input = page.getByRole('textbox', { name: '스레드 이름' });
  await input.fill('인사말 작업');
  await input.press('Enter');
  await expect(page.locator('.app__thread-name')).toHaveText('인사말 작업');
  await expect(page.getByTestId('sidebar').locator('.hc-thread__title').filter({ hasText: '인사말 작업' })).toHaveCount(1);
});

test('model menu names the current lineup (Fable 5.1)', async () => {
  const { page } = run;
  await openDraft(page);
  const model = page.getByTestId('draft').locator('.hc-chip--model');
  await expect(model).toContainText('Fable 5.1');
  await expect(page.getByTestId('statusline').locator('.hc-statusline__model')).toHaveText('Fable 5.1');
  await model.click();
  const menu = page.getByRole('menu', { name: '모델' });
  await expect(menu.getByRole('group', { name: '모델' }).locator('.hc-mnu__label')).toHaveText([
    '기본 (Fable 5.1)',
    'Fable 5.1',
    'Opus 5.5',
    'Sonnet 5',
    'Haiku 4.5',
  ]);
  await screenshot(page, 'v3-model-menu', SHOTS);
  await page.keyboard.press('Escape');
  await openFromMore(page, '계정');
  await expect(page.locator('.hc-accounts-page')).toBeVisible();
  await page.mouse.move(10, 700);
  await screenshot(page, 'v3-accounts', SHOTS);
  await screenshotOf(page, page.getByTestId('statusline'), 'v3-statusline', SHOTS);
});
