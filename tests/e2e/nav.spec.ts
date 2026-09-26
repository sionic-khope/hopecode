// Sidebar navigation (v5): 새 채팅 / 검색 ⌘K / 풀 리퀘스트 / 예약 / 플러그인 + 더보기. Headless (HOPECODE_E2E), fixture
// mode: PRs come from the fixture seam (no gh, no network), the scheduler runs on the fixture clock, and the plugin
// inventory reads a fake shared .claude under HOPECODE_HOME (never the real ~/.claude).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { bootstrapState, createSandbox, launch, screenshot, sendMessage, startThread, type Launched, type Sandbox } from './helpers';

const SHOTS = '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';
/** Mirrors FIXTURE_PR_BRANCH (src/main/fixtures/fixturePrs.ts). */
const PR_BRANCH = 'feature/login-polish';

let sandbox: Sandbox;
let run: Launched;
let prBranchSha: string;

function writeFile(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** Fake shared config (index.ts reads `$HOPECODE_HOME/home/fixture-claude` in fixture mode). */
function seedSharedClaude(home: string): void {
  const root = join(home, 'home', 'fixture-claude');
  const installPath = join(root, 'plugins', 'cache', 'tools', 'formatter', '1.4.0');
  writeFile(
    root,
    'plugins/installed_plugins.json',
    JSON.stringify({ version: 2, plugins: { 'formatter@tools': [{ scope: 'user', installPath, version: '1.4.0' }], 'legacy@tools': [{ version: '0.9.0' }] } }),
  );
  writeFile(root, 'plugins/cache/tools/formatter/1.4.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'formatter', description: '저장할 때 코드를 정리합니다' }));
  writeFile(root, 'plugins/cache/tools/formatter/1.4.0/.mcp.json', JSON.stringify({ mcpServers: { 'format-server': { type: 'stdio', command: 'fmt-mcp' } } }));
  writeFile(
    root,
    'settings.json',
    JSON.stringify({
      enabledPlugins: { 'formatter@tools': true, 'legacy@tools': false },
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }] },
    }),
  );
  writeFile(root, 'skills/release-notes/SKILL.md', '---\nname: release-notes\ndescription: 릴리즈 노트를 씁니다\n---\n');
  writeFile(root, 'skills/broken/SKILL.md', 'frontmatter 없음');
  writeFile(root, 'agents/reviewer.md', '---\nname: reviewer\ndescription: 변경 사항을 검토합니다\n---\n');
  writeFile(root, 'output-styles/terse.md', '---\nname: terse\ndescription: 짧게 답합니다\n---\n');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  sandbox = createSandbox();
  // The branch of fixture PR #42, one commit ahead of main.
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Hopecode E2E', '-c', 'user.email=e2e@example.com', ...args], { cwd: sandbox.project }).toString().trim();
  git('checkout', '-q', '-b', PR_BRANCH);
  writeFileSync(join(sandbox.project, 'LOGIN.md'), '로그인 화면\n');
  git('add', '.');
  git('commit', '-q', '-m', 'login polish');
  prBranchSha = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  seedSharedClaude(sandbox.home);
  run = await launch(sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

test('nav: five entries in order, ⌘K hint, and the 더보기 menu', async () => {
  const { page } = run;
  const nav = page.getByTestId('sidebar-nav');
  const labels = await nav.locator(':scope > button .hc-nav__label').allTextContents();
  expect(labels).toEqual(['새 채팅', '검색', '풀 리퀘스트', '예약', '플러그인', '더보기']);
  await expect(nav.getByRole('button', { name: /^검색/ }).locator('kbd')).toHaveText('⌘K');
  await expect(nav.getByRole('button', { name: /^검색/ }).locator('kbd')).toBeVisible();
  // ⌘N shows on hover next to the round +.
  const compose = nav.getByRole('button', { name: /^새 채팅/ });
  await expect(compose.locator('.hc-nav__plus')).toBeVisible();
  await compose.hover();
  await expect(compose.locator('kbd')).toHaveCSS('opacity', '1');
  await page.mouse.move(700, 400);
  await screenshot(page, 'v5-nav', SHOTS);

  await nav.getByRole('button', { name: '더보기' }).click();
  const more = page.getByRole('menu', { name: '더보기' });
  for (const label of ['계정', '사용량', '설정', '키보드 단축키', '앱 정보']) {
    await expect(more.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  await more.getByRole('menuitem', { name: /^설정/ }).click();
  await expect(page.getByTestId('settings')).toBeVisible();
});

test('검색 opens the palette on thread search: title and first message, then jumps to the thread', async () => {
  const { page } = run;
  await startThread(page, sandbox, '[text] 로그인 화면 문구를 다듬어 주세요');
  await startThread(page, sandbox, '[text] 결제 모듈 리팩터링: 환불 경로 정리');
  // A renamed thread is still found by what its first message said.
  const { threads } = await bootstrapState(page);
  const payment = threads.find((t) => t.title.includes('결제 모듈'))!;
  await page.evaluate((id) => window.hopecode.invoke('thread:rename', { threadId: id, title: '정산 작업' }), payment.id);
  await expect(page.getByTestId('sidebar').locator('.hc-thread').filter({ hasText: '정산 작업' })).toHaveCount(1);

  await page.getByTestId('sidebar-nav').getByRole('button', { name: /^검색/ }).click();
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  const input = page.getByRole('combobox', { name: '명령 검색' });
  await expect(input).toBeFocused();
  // Empty query: threads come first (thread search mode), commands follow in the same list.
  await expect(palette.locator('.hc-palette__group').first()).toHaveText('스레드');

  await input.fill('로그인 화면');
  await expect(palette.getByRole('option').first()).toContainText('로그인 화면 문구');
  await input.fill('환불 경로');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(palette.getByRole('option').first()).toContainText('정산 작업');
  await input.fill('존재하지 않는 제목');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await expect(palette).toContainText('일치하는 항목이 없습니다');
  await input.fill('환불 경로');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.locator('.app__thread-name')).toHaveText('정산 작업');

  // Commands run from the same palette.
  await page.getByTestId('sidebar-nav').getByRole('button', { name: /^검색/ }).click();
  await input.fill('예약');
  await expect(palette.getByRole('option').first()).toContainText('예약');
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('풀 리퀘스트: open PRs (seam), thread link, browser open, and a new chat on the PR branch', async () => {
  const { page } = run;
  await page.getByTestId('sidebar-nav').getByRole('button', { name: '풀 리퀘스트' }).click();
  const prs = page.getByTestId('prs-page');
  await expect(prs.getByRole('heading', { name: '풀 리퀘스트' })).toBeVisible();
  const rows = prs.getByTestId('pr-row');
  await expect(rows).toHaveCount(3);
  // #43 is on the first worktree thread's hopecode/* branch: linked.
  const linked = rows.filter({ hasText: '#43' });
  await expect(linked).toContainText('연결된 스레드');
  await expect(linked).toContainText('CI 실패');
  await expect(linked).toContainText('변경 요청');
  const draftPr = rows.filter({ hasText: '#41' });
  await expect(draftPr).toContainText('Draft');
  await expect(draftPr).toContainText('리뷰 필요');
  const pr42 = rows.filter({ hasText: '#42' });
  await expect(pr42).toContainText('Open');
  await expect(pr42).toContainText('승인됨');
  await expect(pr42).toContainText('CI 통과');
  await expect(pr42).toContainText(PR_BRANCH);
  await expect(pr42).toContainText('octocat');
  await screenshot(page, 'v5-prs', SHOTS);

  // Browser open goes through the github.com-only gate (a no-op seam in e2e); a foreign host is refused in main.
  await pr42.getByRole('button', { name: '브라우저에서 열기' }).click();
  await expect(prs.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.hopecode.invoke('prs:openExternal', { url: 'https://evil.example.com/pull/1' }))).toBe(false);

  await linked.getByRole('button', { name: /로그인 화면 문구/ }).click();
  await expect(page.locator('.app__thread-name')).toContainText('로그인 화면 문구');

  await page.getByTestId('sidebar-nav').getByRole('button', { name: '풀 리퀘스트' }).click();
  await page.getByTestId('pr-row').filter({ hasText: '#42' }).getByRole('button', { name: '이 PR로 새 채팅' }).click();
  await expect(page.getByTestId('draft')).toBeVisible();
  await expect(page.getByTestId('draft-pr-base')).toContainText(`PR #42 ${PR_BRANCH}`);
  const before = await page.getByTestId('sidebar').locator('.hc-thread').count();
  await sendMessage(page, '[text] PR 42 리뷰 반영');
  await expect(page.getByTestId('sidebar').locator('.hc-thread')).toHaveCount(before + 1);
  const { threads } = await bootstrapState(page);
  const prThread = threads.find((t) => t.title.includes('PR 42'))!;
  expect(prThread.worktree?.branch).toMatch(/^hopecode\//);
  // The worktree starts at the PR branch's commit; the project checkout stays on main.
  expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: prThread.cwd }).toString().trim()).toBe(prBranchSha);
  expect(execFileSync('git', ['branch', '--show-current'], { cwd: sandbox.project }).toString().trim()).toBe('main');
});

test('예약: create, run on the fixture clock (new thread + history), bypass refused in main', async () => {
  const { page, app } = run;
  await page.getByTestId('sidebar-nav').getByRole('button', { name: '예약' }).click();
  const schedule = page.getByTestId('schedule-page');
  await expect(schedule.getByRole('heading', { name: '예약' })).toBeVisible();
  await expect(schedule).toContainText('아직 예약이 없습니다');

  await schedule.getByRole('button', { name: '새 예약' }).click();
  const form = schedule.getByRole('form', { name: '새 예약' });
  await form.getByLabel('프롬프트').fill('[text] 아침 점검: 실패한 테스트 정리');
  // Only three permission modes: bypassPermissions is not offered.
  await expect(form.getByRole('radiogroup', { name: '권한 모드' }).getByRole('radio')).toHaveText(['기본', '계획', '편집 자동 승인']);
  await form.getByRole('radiogroup', { name: '권한 모드' }).getByRole('radio', { name: '계획' }).click();
  await form.getByRole('radiogroup', { name: '반복' }).getByRole('radio', { name: '평일' }).click();
  await form.getByLabel('시각').fill('09:00');
  await form.getByRole('button', { name: '저장' }).click();
  const row = schedule.getByTestId('schedule-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('평일 09:00');
  await expect(row).toContainText('다음 실행');
  await screenshot(page, 'v5-schedule', SHOTS);

  // Main refuses bypassPermissions even when the UI is bypassed.
  const refused = await page.evaluate(() =>
    window.hopecode
      .invoke('schedule:save', {
        schedule: {
          projectId: 'x',
          prompt: 'x',
          model: 'default',
          permissionMode: 'bypassPermissions',
          effort: null,
          repeat: { kind: 'daily', time: '09:00' },
          enabled: true,
        } as never,
      })
      .then(() => 'saved')
      .catch((err: Error) => err.message),
  );
  expect(refused).toMatch(/전체 액세스|프로젝트/);

  // Jump the fixture clock to the next occurrence: main starts a thread through thread:start.
  const [saved] = await page.evaluate(() => window.hopecode.invoke('schedule:list'));
  expect(saved!.permissionMode).toBe('plan');
  const before = await page.getByTestId('sidebar').locator('.hc-thread').count();
  await app.evaluate(async (_electron, at) => {
    await globalThis.__hopecodeFixtureClock!.set(at);
  }, saved!.nextRunAt! + 5_000);
  await expect(page.getByTestId('sidebar').locator('.hc-thread')).toHaveCount(before + 1);
  await expect(row.getByRole('list', { name: '실행 이력' })).toContainText('실행됨');
  const { threads } = await bootstrapState(page);
  const scheduled = threads.find((t) => t.title.includes('아침 점검'))!;
  expect(scheduled.permissionMode).toBe('plan');

  await row.getByRole('button', { name: '스레드 열기' }).click();
  await expect(page.locator('.app__thread-name')).toContainText('아침 점검');
  await expect(page.locator('.hc-messages .hc-msg-user__bubble').first()).toHaveText('[text] 아침 점검: 실패한 테스트 정리');

  // Turn it off: no further runs, shown as 꺼짐.
  await page.getByTestId('sidebar-nav').getByRole('button', { name: '예약' }).click();
  await row.getByRole('switch').click();
  await expect(row).toContainText('꺼짐');
});

test('플러그인: read-only inventory of the fake shared .claude, broken entries skipped and listed', async () => {
  const { page } = run;
  await page.getByTestId('sidebar-nav').getByRole('button', { name: '플러그인' }).click();
  const plugins = page.getByTestId('plugins-page');
  await expect(plugins.getByRole('heading', { name: '플러그인', level: 1 })).toBeVisible();
  const section = (name: string) => plugins.getByRole('region', { name });
  await expect(section('플러그인')).toContainText('formatter');
  await expect(section('플러그인')).toContainText('저장할 때 코드를 정리합니다');
  await expect(section('플러그인').getByTestId('plugin-item').filter({ hasText: 'formatter' })).toContainText('활성');
  await expect(section('플러그인').getByTestId('plugin-item').filter({ hasText: 'legacy' })).toContainText('비활성');
  await expect(section('스킬')).toContainText('release-notes');
  await expect(section('에이전트')).toContainText('reviewer');
  await expect(section('출력 스타일')).toContainText('terse');
  await expect(section('MCP 서버')).toContainText('format-server');
  await expect(section('Hooks')).toContainText('PostToolUse (Edit)');
  await expect(section('읽지 못한 항목')).toContainText('skills/broken/SKILL.md');
  await expect(plugins).toContainText('claude /plugin');
  await expect(plugins.getByRole('button', { name: '폴더 열기' })).toBeVisible();
  await screenshot(page, 'v5-plugins', SHOTS);
  // 폴더 열기 is a no-op in e2e (never opens Finder).
  await plugins.getByRole('button', { name: '폴더 열기' }).click();
  await expect(plugins.getByRole('alert')).toHaveCount(0);
});
