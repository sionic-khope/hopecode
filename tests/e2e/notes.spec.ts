// 노트 모드: nav entry, vault via the dialog seam (a temp git repo, never a real notes folder), tree, new file,
// autosave, Live Preview, AI requests streamed from the fixtures (Claude fakeQuery / fake ACP Codex), section-only
// replacement, full rewrite, ⌘Z, a Codex tool call that is cancelled with the note left as it was, and a commit of
// the changed notes after the git opt-in (no push). Fixture mode only.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createSandbox, launch, screenshot, type Launched, type Sandbox } from './helpers';

const DIR = '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let vault: string;
let run: Launched;

const git = (...args: string[]) => execFileSync('git', args, { cwd: vault, encoding: 'utf8' });
const note = (rel: string) => readFileSync(join(vault, rel), 'utf8');

test.beforeAll(async () => {
  sandbox = createSandbox();
  vault = mkdtempSync(join(tmpdir(), 'hopecode-e2e-notes-'));
  mkdirSync(join(vault, 'Back-End'), { recursive: true });
  mkdirSync(join(vault, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(vault, 'public'), { recursive: true });
  writeFileSync(join(vault, 'Back-End', 'intro.md'), '# 소개\n\n기존 노트다. 문체 참고용이다.\n');
  writeFileSync(join(vault, 'node_modules', 'pkg', 'README.md'), '# hidden\n');
  writeFileSync(join(vault, 'public', 'index.md'), '# hidden\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Hopecode E2E');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('add', 'Back-End');
  git('commit', '-q', '-m', 'init');
  run = await launch(sandbox, { env: { HOPECODE_FIXTURE_NOTES: vault } });
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
  if (vault) rmSync(vault, { recursive: true, force: true });
});

async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  for (const line of text.split('\n')) {
    if (line) await page.keyboard.insertText(line);
    await page.keyboard.press('Enter');
  }
}

async function request(page: Page, mode: '작성' | '이 섹션' | '전체 수정', text: string): Promise<void> {
  const chat = page.getByTestId('note-chat');
  await chat.getByRole('radio', { name: mode }).click();
  const before = await chat.getByTestId('note-chat-assistant').count();
  await chat.locator('.hc-composer__textarea').fill(text);
  await chat.getByRole('button', { name: '보내기' }).click();
  await expect(chat.getByTestId('note-chat-assistant')).toHaveCount(before + 1);
  await expect(chat.getByTestId('note-chat-running')).toHaveCount(0);
}

async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('notes-save-state')).toHaveText('저장됨');
}

test('노트 nav opens the notes page and the dialog seam registers the vault', async () => {
  const { page } = run;
  const nav = page.getByTestId('sidebar-nav');
  // 노트 sits right above 더보기.
  const labels = await nav.locator('.hc-nav__label').allTextContents();
  expect(labels.indexOf('노트')).toBe(labels.indexOf('더보기') - 1);
  await nav.getByRole('button', { name: '노트', exact: true }).click();
  await expect(page.getByTestId('notes-page')).toBeVisible();
  await page.getByTestId('notes-add-vault').click();
  const tree = page.getByTestId('note-tree');
  await expect(tree.locator('[data-path="Back-End"]')).toBeVisible();
  await expect(tree).not.toContainText('node_modules');
  await expect(tree).not.toContainText('public');
});

test('new note in a folder, typing autosaves the file atomically', async () => {
  const { page } = run;
  const tree = page.getByTestId('note-tree');
  await tree.locator('[data-path="Back-End"]').click();
  await expect(tree.locator('[data-path="Back-End/intro.md"]')).toBeVisible();
  await page.getByTestId('note-new-file').click();
  await page.getByTestId('note-new-name').fill('redis-lock');
  await page.getByTestId('note-new-name').press('Enter');
  await expect(page.getByTestId('notes-open-path')).toHaveText('Back-End/redis-lock.md');
  await typeInEditor(page, '# 분산 락\n\n첫 본문이다.\n\n## 둘째\n\n둘째 본문.');
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toBe('# 분산 락\n\n첫 본문이다.\n\n## 둘째\n\n둘째 본문.\n');
  // Name search finds it.
  await page.getByTestId('note-search').fill('redis');
  await expect(page.getByTestId('note-search-results')).toContainText('redis-lock');
  await page.getByTestId('note-search').fill('');
});

test('Live Preview renders the heading line without its marks; the caret line shows the source', async () => {
  const { page } = run;
  const h1 = page.locator('.cm-line.cm-md-h1');
  await expect(h1).toHaveText('분산 락');
  await h1.click();
  await expect(h1).toHaveText('# 분산 락');
  await page.locator('.cm-line', { hasText: '둘째 본문.' }).click();
  await expect(h1).toHaveText('분산 락');
});

test('작성 streams a study note into the caret position', async () => {
  const { page } = run;
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await request(page, '작성', 'Redis 분산 락');
  await expect(page.locator('.cm-content')).toContainText('fixture가 스트리밍으로 쓴 본문이다.');
  await expect(page.getByTestId('note-chat')).toContainText('커서 위치에');
  await waitSaved(page);
  const text = note('Back-End/redis-lock.md');
  expect(text.startsWith('# 분산 락\n\n첫 본문이다.\n\n## 둘째\n\n둘째 본문.\n\n# Redis 분산 락\n')).toBe(true);
  expect(text).toContain('```java\nint answer = 42;\n```');
});

test('이 섹션 frames the section at the caret and replaces only it; ⌘Z restores it in one step', async () => {
  const { page } = run;
  await page.locator('.cm-line', { hasText: '첫 본문이다.' }).click();
  await page.getByTestId('note-chat').getByRole('radio', { name: '이 섹션' }).click();
  await expect(page.locator('.cm-note-target').first()).toBeVisible();
  await screenshot(page, 'v17-notes', DIR);
  await request(page, '이 섹션', '더 자세히');
  await waitSaved(page);
  let text = note('Back-End/redis-lock.md');
  expect(text).toContain('# 분산 락\n\nFIXTURE-SECTION: 더 자세히 요청대로 다시 쓴 섹션이다.\n');
  expect(text).not.toContain('첫 본문이다.');
  // Sections below the target are untouched (## 둘째 is a subsection of the h1, so the h1 section ends at the next h1).
  expect(text).toContain('# Redis 분산 락');

  await page.locator('.cm-content').focus();
  await page.keyboard.press('Meta+z');
  await expect(page.locator('.cm-content')).toContainText('첫 본문이다.');
  await waitSaved(page);
  text = note('Back-End/redis-lock.md');
  expect(text).toContain('첫 본문이다.');
  expect(text).not.toContain('FIXTURE-SECTION');
});

test('전체 수정 rewrites the whole note (Codex through the fake ACP agent)', async () => {
  const { page } = run;
  const chat = page.getByTestId('note-chat');
  await chat.locator('.hc-chip--agent').click();
  const menu = page.getByRole('menu', { name: '에이전트' });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
  await menu.getByRole('menuitemradio', { name: /^Codex/ }).click();
  await request(page, '전체 수정', '정리');
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toBe('# 전체 수정본\n\nCODEX-REWRITE: 정리 요청대로 문서 전체를 다시 썼다.\n');
  // A tool call in a Codex note request: the turn is cancelled, an error shows and the note stays as it was.
  const saved = note('Back-End/redis-lock.md');
  await request(page, '전체 수정', '[tool] 정리');
  await expect(chat.getByRole('alert')).toContainText('도구를 쓰려고 해서');
  // The half answer streamed before the tool call (it carries the request text) was rolled back.
  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('CODEX-REWRITE: 정리 요청대로 문서 전체를 다시 썼다.');
  await expect(editor).not.toContainText('[to');
  await expect(editor).not.toContainText('FAKE-SECRET-KEY');
  expect(note('Back-End/redis-lock.md')).toBe(saved);
  // Back to Claude for the rest of the run.
  await chat.locator('.hc-chip--agent').click();
  await page.getByRole('menu', { name: '에이전트' }).getByRole('menuitemradio', { name: /^Claude Code/ }).click();
  await request(page, '전체 수정', '다시');
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toContain('FIXTURE-REWRITE: 다시');
});

test('커밋 asks once to turn git on, then commits only the changed notes (no push)', async () => {
  const { page } = run;
  const button = page.getByTestId('notes-commit');
  // Git is off for the vault until the user confirms: no status ran, so no count yet.
  await expect(page.getByTestId('notes-changed-count')).toHaveCount(0);
  await button.click();
  await expect(page.getByTestId('notes-git-optin')).toBeVisible();
  await page.getByTestId('notes-git-optin-confirm').click();
  await expect(page.getByTestId('notes-changed-count')).toHaveText('1');
  await page.getByTestId('notes-commit-message').fill('notes: redis lock');
  await page.getByTestId('notes-commit-confirm').click();
  await expect(page.getByTestId('notes-changed-count')).toHaveText('0');
  expect(git('log', '-1', '--format=%s').trim()).toBe('notes: redis lock');
  expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('Back-End/redis-lock.md');
  expect(git('remote').trim()).toBe('');
  // node_modules / public stay untracked: only notes were added.
  expect(git('status', '--porcelain')).toContain('node_modules/');
});

test('rename and trash (confirmed) work on files inside the vault', async () => {
  const { page } = run;
  const tree = page.getByTestId('note-tree');
  const row = tree.locator('[data-path="Back-End/intro.md"]');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '이름 바꾸기' }).click();
  await page.getByTestId('note-rename').fill('overview');
  await page.getByTestId('note-rename').press('Enter');
  await expect(tree.locator('[data-path="Back-End/overview.md"]')).toBeVisible();
  expect(note('Back-End/overview.md')).toContain('기존 노트다.');

  await tree.locator('[data-path="Back-End/overview.md"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '휴지통으로 이동' }).click();
  await page.getByTestId('note-trash-confirm').click();
  await expect(tree.locator('[data-path="Back-End/overview.md"]')).toHaveCount(0);
  // Fixture runs move it under HOPECODE_HOME instead of the user's Trash.
  expect(() => note('Back-End/overview.md')).toThrow();
});
