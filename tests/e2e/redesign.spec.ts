// Codex-style shell: draft-first new chat (⌘N), folder chip + thread:start (thread, worktree, auto title),
// composer chips (permission / model + effort / account), file attach mention, sidebar pin / archive / search /
// collapse (⌘B), Korean UI copy. Screenshots of each state go to the redesign folder.
import { expect, test } from '@playwright/test';
import {
  bootstrapState,
  chooseFixtureFolder,
  createSandbox,
  launch,
  menuShortcut,
  screenshot,
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

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

const FIRST = '[text] 로그인 화면에서 비밀번호 재설정 링크가 동작하지 않는 문제를 고쳐 주세요';

test('launch opens a draft; sending without a folder points at the folder chip and keeps the text', async () => {
  const { page } = run;
  const draft = page.getByTestId('draft');
  await expect(draft).toBeVisible();
  await expect(draft.getByRole('heading', { name: '무엇을 만들어 볼까요?' })).toBeVisible();
  const chip = draft.locator('.hc-chip--folder');
  await expect(chip).toHaveText(/폴더 선택/);
  const box = page.locator('.hc-composer__textarea');
  await expect(box).toHaveAttribute('placeholder', '무엇이든 요청하세요');
  // No toolbar above the chat any more: the controls live in the composer.
  await expect(page.locator('.hc-toolbar')).toHaveCount(0);
  await screenshot(page, 'v2-draft-empty-no-folder', SHOTS);

  await sendMessage(page, FIRST);
  await expect(chip).toHaveClass(/hc-chip--attention/);
  await expect(page.getByRole('menu', { name: '폴더' })).toBeVisible();
  await expect(draft.getByRole('alert')).toHaveText('먼저 작업할 폴더를 선택하세요');
  await expect(box).toHaveValue(FIRST);
  expect((await bootstrapState(page)).threads).toHaveLength(0);
  await page.keyboard.press('Escape');
});

test('folder chip (dialog seam) -> first send creates the thread and its worktree, titled from the message', async () => {
  const { page } = run;
  await chooseFixtureFolder(page, sandbox);
  const box = page.locator('.hc-composer__textarea');
  await expect(box).toHaveValue(FIRST);
  await box.press('Enter');

  const rows = page.getByTestId('sidebar').locator('.hc-thread');
  await expect(rows).toHaveCount(1);
  const title = '[text] 로그인 화면에서 비밀번호 재설정 링크가 동작하지 않는 문제를…';
  await expect(rows.first().locator('.hc-thread__title')).toHaveText(title);
  await expect(page.locator('.app__thread-name')).toHaveText(title);
  await expect(page.locator('.hc-messages .hc-msg-user__bubble')).toHaveText(FIRST);
  await expect(page.locator('.hc-messages')).toContainText('Streaming reply from the fixture session.');

  const { threads, projects } = await bootstrapState(page);
  expect(projects.map((p) => p.path)).toEqual([sandbox.project]);
  expect(threads).toHaveLength(1);
  expect(threads[0]).toMatchObject({ title, pinned: false, archived: false });
  expect(threads[0].cwd.startsWith(`${sandbox.home}/home/worktrees/`)).toBe(true);
  expect(threads[0].worktree?.branch).toMatch(/^hopecode\//);
  // A started chat shows its folder read-only; "폴더 변경" is disabled.
  await expect(page.locator('.hc-composer .hc-chip--static:not(.hc-chip--agent)')).toContainText(sandbox.project.split('/').pop()!);
  await page.locator('.hc-composer__plus').click();
  await expect(page.getByRole('menuitem', { name: /폴더 변경/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  // Closing a mouse-opened menu with Escape hands focus back without a keyboard focus ring.
  await expect(page.locator('.hc-composer__plus')).toBeFocused();
  expect(await page.locator('.hc-composer__plus').evaluate((el) => el.matches(':focus-visible'))).toBe(false);
  await page.mouse.move(900, 300);
  await screenshot(page, 'v2-conversation', SHOTS);
});

test('+ > 파일 첨부 inserts the picked file as an @ mention', async () => {
  const { page } = run;
  const box = page.locator('.hc-composer__textarea');
  await box.fill('이 파일을 요약해 줘');
  await page.locator('.hc-composer__plus').click();
  await page.getByRole('menuitem', { name: /파일 첨부/ }).click();
  await expect(box).toHaveValue('이 파일을 요약해 줘 @README.md ');
  await box.fill('');
});

test('⌘N opens a draft at once in the last used folder; nothing is created until the first send', async () => {
  const { page } = run;
  await menuShortcut(run.app, 'CmdOrCtrl+N');
  const draft = page.getByTestId('draft');
  await expect(draft).toBeVisible();
  await expect(draft.locator('.hc-chip--folder')).toContainText(sandbox.project.split('/').pop()!);
  await expect(page.locator('.hc-composer__textarea')).toBeFocused();
  await expect(page.getByTestId('sidebar').getByRole('button', { name: /^새 채팅/ })).toHaveAttribute('aria-current', 'page');
  expect((await bootstrapState(page)).threads).toHaveLength(1);
  // The composer names the concrete model, and so does the statusline before anything is sent.
  await expect(draft.locator('.hc-chip--model')).toContainText('Fable 5.1');
  await expect(draft.locator('.hc-chip--model')).not.toContainText('Default');
  await expect(page.getByTestId('statusline').locator('.hc-statusline__model')).toHaveText('Fable 5.1');
  await expect(draft.locator('.hc-draft__hint')).toHaveText('');
  const send = page.locator('.hc-send');
  await expect(send).toBeDisabled();
  await screenshot(page, 'v2-draft-empty', SHOTS);
  await page.locator('.hc-composer__textarea').fill('README의 인사말을 Hopecode로 바꾸고 테스트를 추가해 주세요');
  await expect(send).toBeEnabled();
  await expect.poll(() => send.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(27, 110, 243)');
  await screenshot(page, 'v2-draft-typed', SHOTS);
  await page.locator('.hc-composer__textarea').fill('');

  await draft.locator('.hc-chip--folder').click();
  const menu = page.getByRole('menu', { name: '폴더' });
  await expect(menu.getByRole('menuitemradio', { name: new RegExp(sandbox.project.split('/').pop()!) })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(menu.getByRole('menuitem', { name: '다른 폴더 선택…' })).toBeVisible();
  // Home-relative paths are shown with ~ (the fixture repo lives in the OS temp dir, outside home, so it stays absolute).
  await expect(menu.locator('.hc-mnu__desc').first()).not.toContainText('/Users/');
  await screenshot(page, 'v2-folder-menu', SHOTS);
  await page.keyboard.press('Escape');
});

test('draft permission + model/effort choices reach the new thread', async () => {
  const { page } = run;
  const perm = page.locator('.hc-chip--perm');
  await expect(perm).toHaveText(/기본/);
  await perm.click();
  const permMenu = page.getByRole('menu', { name: '권한' });
  for (const label of ['기본', '계획', '편집 자동 승인', '전체 액세스']) {
    await expect(permMenu.getByRole('menuitemradio', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  await expect(permMenu.getByRole('menuitemradio', { name: /^전체 액세스/ })).toHaveClass(/hc-mnu__item--warn/);
  await screenshot(page, 'v2-permission-menu', SHOTS);
  await permMenu.getByRole('menuitemradio', { name: /^계획/ }).click();
  await expect(perm).toHaveText(/계획/);

  const model = page.locator('.hc-chip--model');
  await model.click();
  const modelMenu = page.getByRole('menu', { name: '모델' });
  await expect(modelMenu.getByRole('group', { name: 'Effort' })).toBeVisible();
  await expect(modelMenu.getByRole('group', { name: '모델' }).locator('.hc-mnu__label')).toHaveText([
    '기본 (Fable 5.1)',
    'Fable 5.1',
    'Opus 5.5',
    'Sonnet 5',
    'Haiku 4.5',
  ]);
  // Every composer menu shares one width.
  // Layout width (the open animation scales the box for a few frames).
  const menuWidth = () => page.locator('.hc-popover:has(.hc-mnu)').evaluate((el) => (el as HTMLElement).offsetWidth);
  const modelW = await menuWidth();
  await screenshot(page, 'v2-model-menu', SHOTS);
  await modelMenu.getByRole('menuitemradio', { name: /^Max/ }).click();
  await perm.click();
  expect(await menuWidth()).toBe(modelW);
  await page.keyboard.press('Escape');
  await expect(model).toContainText('Max');

  await sendMessage(page, '[whoami] 초안 설정 확인');
  await expect(page.locator('.hc-messages')).toContainText('permissionMode=plan');
  await expect(page.locator('.hc-messages')).toContainText('effort=max');
  const { threads } = await bootstrapState(page);
  expect(threads.find((t) => t.title === '[whoami] 초안 설정 확인')).toMatchObject({ permissionMode: 'plan', effort: 'max' });
});

test('effort on a live thread goes to the running session and persists', async () => {
  const { page } = run;
  const model = page.locator('.hc-chip--model');
  await model.click();
  await page.getByRole('menu', { name: '모델' }).getByRole('menuitemradio', { name: /^Low/ }).click();
  await expect(model).toContainText('Low');
  await sendMessage(page, '[whoami] effort low');
  await expect(page.locator('.hc-messages')).toContainText('effort=low');

  await model.click();
  await page.getByRole('menu', { name: '모델' }).getByRole('menuitemradio', { name: /^기본값/ }).click();
  await expect(model).not.toContainText('Low');
  await sendMessage(page, '[whoami] effort default');
  await expect(page.locator('.hc-messages').getByText(/effort=default/)).toBeVisible();
  const { threads } = await bootstrapState(page);
  expect(threads.find((t) => t.title === '[whoami] 초안 설정 확인')?.effort).toBeNull();
});

test('sidebar search filters threads by title', async () => {
  const { page } = run;
  await startThread(page, sandbox, '[text] 두 번째 스레드: 결제 모듈 리팩터링');
  const sidebar = page.getByTestId('sidebar');
  const rows = sidebar.locator('.hc-thread');
  await expect(rows).toHaveCount(3);

  await sidebar.getByRole('button', { name: '검색', exact: true }).click();
  const input = sidebar.getByRole('searchbox', { name: '스레드 제목 검색' });
  await expect(input).toBeFocused();
  await input.fill('결제');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('결제 모듈');
  await input.fill('존재하지 않는 제목');
  await expect(rows).toHaveCount(0);
  await expect(sidebar).toContainText('일치하는 스레드가 없습니다');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(rows).toHaveCount(3);
});

test('pin and archive: hover buttons and context menu, persisted in main', async () => {
  const { page } = run;
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar.getByRole('region', { name: '고정된 스레드' })).toHaveCount(0);

  const target = sidebar.locator('.hc-thread-wrap').filter({ hasText: '결제 모듈' });
  await target.hover();
  await target.getByRole('button', { name: /고정$/ }).click();
  const pinned = sidebar.getByRole('region', { name: '고정된 스레드' });
  await expect(pinned).toBeVisible();
  await expect(pinned.locator('.hc-thread')).toHaveCount(1);
  await expect(pinned).toContainText('결제 모듈');
  let state = await bootstrapState(page);
  expect(state.threads.find((t) => t.title.includes('결제 모듈'))?.pinned).toBe(true);
  await page.mouse.move(700, 400);
  await screenshot(page, 'v2-sidebar-pinned', SHOTS);

  // Archive the first thread through its context menu: it leaves the lists and appears under 보관됨.
  const first = sidebar.locator('.hc-project .hc-thread-wrap').filter({ hasText: '로그인 화면' });
  await first.locator('.hc-thread').click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '스레드 작업' }).getByRole('menuitem')).toHaveText(['이름 변경', '고정', '보관', '삭제…']);
  await page.getByRole('menuitem', { name: '보관', exact: true }).click();
  await expect(sidebar.locator('.hc-project .hc-thread-wrap').filter({ hasText: '로그인 화면' })).toHaveCount(0);
  const archived = sidebar.getByRole('region', { name: '보관된 스레드' });
  await expect(archived).toContainText('1');
  state = await bootstrapState(page);
  expect(state.threads.find((t) => t.title.includes('로그인 화면'))).toMatchObject({ archived: true, pinned: false });

  await archived.getByRole('button', { name: /보관됨/ }).click();
  const archivedRow = archived.locator('.hc-thread-wrap');
  await archivedRow.hover();
  await archivedRow.getByRole('button', { name: /보관 해제$/ }).click();
  await expect(archived).toHaveCount(0);
  await expect(sidebar.locator('.hc-project .hc-thread-wrap').filter({ hasText: '로그인 화면' })).toHaveCount(1);
  expect((await bootstrapState(page)).threads.every((t) => !t.archived)).toBe(true);
});

test('⌘B collapses the sidebar to a full-width chat; the titlebar button brings it back', async () => {
  const { page } = run;
  const app = page.locator('.app');
  await menuShortcut(run.app, 'CmdOrCtrl+B');
  await expect(app).toHaveClass(/app--sidebar-collapsed/);
  await expect.poll(async () => (await page.getByTestId('sidebar').boundingBox())?.width ?? -1).toBeLessThan(1);
  // The conversation card spans the window, inset only by the canvas gap.
  await expect.poll(async () => (await page.getByTestId('chat').boundingBox())?.x ?? -1).toBeLessThanOrEqual(8);
  const show = page.getByTestId('chat').getByRole('button', { name: '사이드바 보기 (⌘B)' });
  await expect(show).toBeVisible();
  await screenshot(page, 'v2-sidebar-collapsed', SHOTS);
  await show.click();
  await expect(app).not.toHaveClass(/app--sidebar-collapsed/);
  await expect.poll(async () => (await page.getByTestId('sidebar').boundingBox())?.width ?? 0).toBeGreaterThan(200);
});

test('계정 opens the Accounts page (Korean copy)', async () => {
  const { page } = run;
  await page.getByTestId('sidebar').getByRole('button', { name: /^계정/ }).click();
  const accounts = page.locator('.hc-accounts-page');
  await expect(accounts.getByRole('heading', { name: '계정' })).toBeVisible();
  await expect(accounts).toContainText('3/3 활성');
  await expect(accounts.getByRole('button', { name: '+ 계정 추가' })).toBeVisible();
  await screenshot(page, 'v2-accounts', SHOTS);
});
