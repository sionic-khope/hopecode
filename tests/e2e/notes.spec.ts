// 노트 모드: nav entry (the sidebar folds away, "← 돌아가기" / Esc bring it back), vault via the dialog seam (a temp git
// repo, never a real notes folder), editor | conversation half and half with a draggable middle, the file drawer from
// the breadcrumb (new note, search, rename, trash) and ⌘P, autosave, Live Preview, the inline prompt over a dragged
// selection (only the selection changes; ⌘Z puts it back), conversation turns answered in the chat (rendered in full,
// no card) or — when asked to write — streamed straight into the editor with a result line (보기, 되돌리기, ⌘Z, a section
// replaced by heading, a missing section refused), the document viewer, drag-select and copy in the chat, a Codex tool
// call that ends the turn with nothing kept, and a commit of the changed notes after the git opt-in (no push). Fixture
// mode only, window hidden.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
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
  git('config', 'user.name', 'deltax E2E');
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

/** Sends a conversation turn and waits for its answer; returns the answer row. */
async function ask(page: Page, text: string): Promise<Locator> {
  const chat = page.getByTestId('note-chat');
  const before = await chat.getByTestId('note-chat-assistant').count();
  await chat.locator('.hc-composer__textarea').fill(text);
  await chat.getByRole('button', { name: '보내기' }).click();
  await expect(chat.getByTestId('note-chat-assistant')).toHaveCount(before + 1);
  await expect(chat.getByTestId('note-chat-running')).toHaveCount(0);
  return chat.getByTestId('note-chat-assistant').last();
}

/** Drags across all the text of `target` (a real pointer drag); returns what the page selected. */
async function dragOver(page: Page, target: Locator): Promise<string> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const first = rects[0];
    const last = rects[rects.length - 1];
    return { x0: first.left + 1, y0: first.top + first.height / 2, x1: last.right - 1, y1: last.top + last.height / 2 };
  });
  await page.mouse.move(box.x0, box.y0);
  await page.mouse.down();
  await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 4 });
  await page.mouse.move(box.x1, box.y1, { steps: 4 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('notes-save-state')).toHaveText('저장됨');
}

/** Drags across `text` inside the editor line that holds it (a real pointer drag, start to end). */
async function dragSelect(page: Page, text: string): Promise<void> {
  const line = page.locator('.cm-line', { hasText: text });
  const box = await line.evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? '').indexOf(needle);
      if (i === -1) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + needle.length);
      const r = range.getBoundingClientRect();
      return { x0: r.left + 1, x1: r.right - 1, y: r.top + r.height / 2 };
    }
    throw new Error(`text not found: ${needle}`);
  }, text);
  await page.mouse.move(box.x0, box.y);
  await page.mouse.down();
  await page.mouse.move((box.x0 + box.x1) / 2, box.y, { steps: 4 });
  await page.mouse.move(box.x1, box.y, { steps: 4 });
  await page.mouse.up();
}

test('노트 nav folds the sidebar, the dialog seam registers the vault and the file drawer opens', async () => {
  const { page } = run;
  const nav = page.getByTestId('sidebar-nav');
  // 노트 sits right above 더보기.
  const labels = await nav.locator('.hc-nav__label').allTextContents();
  expect(labels.indexOf('노트')).toBe(labels.indexOf('더보기') - 1);
  await nav.getByRole('button', { name: '노트', exact: true }).click();
  await expect(page.getByTestId('notes-page')).toBeVisible();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('notes-back')).toBeVisible();
  // The folded sidebar must not leave a (native, invisible) window-drag region over the back button: the real window
  // routes clicks there to a title-bar drag, which synthetic test clicks never hit.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const card = document.querySelector('.app__sidebar-card') as HTMLElement;
        const bar = card.querySelector('.drag-region') as HTMLElement;
        const back = document.querySelector('[data-testid="notes-back"]') as HTMLElement;
        const style = getComputedStyle(bar) as CSSStyleDeclaration & { webkitAppRegion?: string };
        const b = back.getBoundingClientRect();
        return {
          card: getComputedStyle(card).visibility,
          region: style.webkitAppRegion ?? style.getPropertyValue('-webkit-app-region'),
          hit: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('[data-testid="notes-back"]') !== null,
        };
      }),
    )
    .toEqual({ card: 'hidden', region: 'no-drag', hit: true });
  await page.getByTestId('notes-add-vault').click();
  // Nothing open yet: the drawer is where to start.
  const drawer = page.getByTestId('note-drawer');
  await expect(drawer).toHaveAttribute('role', 'dialog');
  const tree = page.getByTestId('note-tree');
  await expect(tree.locator('[data-path="Back-End"]')).toBeVisible();
  await expect(tree).not.toContainText('node_modules');
  await expect(tree).not.toContainText('public');
  // No source / Live / read toggle and no request-scope segments any more.
  await expect(page.getByRole('radiogroup', { name: '보기' })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: '요청 범위' })).toHaveCount(0);
  await screenshot(page, 'v18-notes-drawer', DIR);
});

test('new note from the drawer, typing autosaves the file atomically; name search and ⌘P switch notes', async () => {
  const { page } = run;
  const tree = page.getByTestId('note-tree');
  await tree.locator('[data-path="Back-End"]').click();
  await expect(tree.locator('[data-path="Back-End/intro.md"]')).toBeVisible();
  await page.getByTestId('note-new-file').click();
  await page.getByTestId('note-new-name').fill('redis-lock');
  await page.getByTestId('note-new-name').press('Enter');
  await expect(page.getByTestId('notes-open-path')).toHaveText('Back-End/redis-lock.md');
  // Opening a note closes the drawer.
  await expect(page.getByTestId('note-drawer')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('note-chat')).toContainText('이 노트에 대해 자유롭게 이야기하세요.');
  await screenshot(page, 'v18-notes-empty', DIR);
  await typeInEditor(page, '# 분산 락\n\n첫 본문이다.\n\n## 둘째\n\n둘째 본문.');
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toBe('# 분산 락\n\n첫 본문이다.\n\n## 둘째\n\n둘째 본문.\n');

  // The breadcrumb opens the drawer; name search finds the note.
  await page.getByTestId('notes-breadcrumb').click();
  await page.getByTestId('note-search').fill('redis');
  await expect(page.getByTestId('note-search-results')).toContainText('redis-lock');
  await page.getByTestId('note-search').fill('');
  await page.getByTestId('note-search').press('Escape');
  await expect(page.getByTestId('note-drawer')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('notes-page')).toBeVisible();

  // ⌘P: open by name, and back.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+p');
  await page.getByTestId('note-quickopen-input').fill('intro');
  await expect(page.getByTestId('note-quickopen').getByRole('option')).toHaveCount(1);
  await page.getByTestId('note-quickopen-input').press('Enter');
  await expect(page.getByTestId('notes-open-path')).toHaveText('Back-End/intro.md');
  await expect(page.locator('.cm-content')).toContainText('기존 노트다.');
  await page.keyboard.press('Meta+p');
  await page.getByTestId('note-quickopen-input').fill('redis');
  await page.getByTestId('note-quickopen-input').press('Enter');
  await expect(page.getByTestId('notes-open-path')).toHaveText('Back-End/redis-lock.md');
});

test('editor and conversation split half and half; the middle drags and double-click resets it', async () => {
  const { page } = run;
  const left = page.getByTestId('notes-editor-pane');
  const right = page.getByTestId('notes-chat-pane');
  const widths = async () => [(await left.boundingBox())!.width, (await right.boundingBox())!.width];
  let [l, r] = await widths();
  expect(Math.abs(l - r)).toBeLessThanOrEqual(2);
  const split = (await page.getByTestId('notes-split').boundingBox())!;
  const y = split.y + split.height / 2;
  await page.mouse.move(split.x, y);
  await page.mouse.down();
  await page.mouse.move(split.x + 120, y, { steps: 6 });
  await page.mouse.up();
  [l, r] = await widths();
  expect(l - r).toBeGreaterThan(200);
  const moved = (await page.getByTestId('notes-split').boundingBox())!;
  await page.mouse.dblclick(moved.x, y);
  [l, r] = await widths();
  expect(Math.abs(l - r)).toBeLessThanOrEqual(2);
});

test('Live Preview renders the heading line without its marks; the caret line shows the source', async () => {
  const { page } = run;
  const h1 = page.locator('.cm-line.cm-md-h1');
  await page.locator('.cm-line', { hasText: '첫 본문이다.' }).click();
  await expect(h1).toHaveText('분산 락');
  await h1.click();
  await expect(h1).toHaveText('# 분산 락');
  await page.locator('.cm-line', { hasText: '둘째 본문.' }).click();
  await expect(h1).toHaveText('분산 락');
  // Typing never draws a frame around the section any more.
  await expect(page.locator('.cm-note-mark')).toHaveCount(0);
});

test('a question is answered in the chat: the whole answer renders as it streams, no card, the editor untouched', async () => {
  const { page } = run;
  const chat = page.getByTestId('note-chat');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  const saved = note('Back-End/redis-lock.md');
  const shown = await page.locator('.cm-content').innerText();

  // While it streams, the answer is already markdown in the conversation (not a card filling in).
  await chat.locator('.hc-composer__textarea').fill('[slow] RL 6개 커리큘럼 짜 주세요. 일단 커리큘럼만');
  await chat.getByRole('button', { name: '보내기' }).click();
  const running = chat.getByTestId('note-chat-running');
  await expect(running.locator('.hc-md h2')).toHaveText('[slow] RL 6개 커리큘럼 짜 주세요. 일단 커리큘럼만');
  await expect(running.getByTestId('note-result')).toHaveCount(0);
  await expect(running).toHaveCount(0, { timeout: 10_000 });

  const answer = chat.getByTestId('note-chat-assistant').last();
  await expect(answer.locator('.hc-md h2')).toHaveText('[slow] RL 6개 커리큘럼 짜 주세요. 일단 커리큘럼만');
  await expect(answer.locator('.hc-md table tr')).toHaveCount(7);
  await expect(answer.locator('.hc-md table')).toContainText('Actor-Critic과 PPO');
  await expect(answer.getByTestId('note-result')).toHaveCount(0);
  await expect(answer.getByTestId('note-doc-chip')).toHaveCount(0);
  await expect(answer.getByRole('button', { name: /본문에 넣기|펼치기/ })).toHaveCount(0);
  expect(await page.locator('.cm-content').innerText()).toBe(shown);
  expect(note('Back-End/redis-lock.md')).toBe(saved);
  await page.mouse.move(5, 700);
  await screenshot(page, 'v23-notes-chat', DIR);
});

test('"노트로 작성해 줘" streams straight into the editor; the result line shows, reveals and reverts it; ⌘Z undoes it in one step', async () => {
  const { page } = run;
  const chat = page.getByTestId('note-chat');
  const editor = page.locator('.cm-content');
  const original = '# 분산 락\n\n첫 본문이다.\n\n## 둘째\n\n둘째 본문.\n';
  expect(note('Back-End/redis-lock.md')).toBe(original);
  await editor.click();
  await page.keyboard.press('Meta+ArrowDown');

  // Mid-stream: the range being written is marked in the editor and the result line says so.
  await chat.locator('.hc-composer__textarea').fill('[slow] Redis 분산 락 노트로 작성해 줘');
  await chat.getByRole('button', { name: '보내기' }).click();
  const running = chat.getByTestId('note-chat-running');
  await expect(running.getByTestId('note-result')).toHaveAttribute('data-status', 'writing');
  await expect(running.getByTestId('note-result-status')).toHaveText('문서에 쓰는 중');
  await expect(page.locator('.cm-note-mark--busy').first()).toBeVisible();
  await expect(editor).toContainText('[slow] Redis 분산 락 노트로 작성해 줘');
  await expect(running).toHaveCount(0, { timeout: 10_000 });

  const answer = chat.getByTestId('note-chat-assistant').last();
  const result = answer.getByTestId('note-result');
  await expect(result).toHaveCount(1);
  await expect(result.getByTestId('note-result-status')).toHaveText('문서에 반영함');
  await expect(result.getByTestId('note-result-target')).toHaveText('커서 위치에 삽입');
  await expect(result.getByTestId('note-doc-chip')).toContainText('[slow] Redis 분산 락 노트로 작성해 줘');
  await expect(result.getByTestId('note-doc-chip')).toContainText('줄');
  // The chat keeps a one-line sentence and the result, never the note text itself.
  await expect(answer).toContainText('노트 초안을 만들었습니다.');
  await expect(answer).not.toContainText('FIXTURE가 스트리밍으로 쓴 본문입니다.');
  await expect(answer.getByRole('button', { name: '본문에 넣기' })).toHaveCount(0);
  await expect(editor).toContainText('FIXTURE가 스트리밍으로 쓴 본문입니다.');
  await expect(page.locator('.cm-note-mark--busy')).toHaveCount(0);
  await waitSaved(page);
  let text = note('Back-End/redis-lock.md');
  expect(text.startsWith(`${original}\n# [slow] Redis 분산 락 노트로 작성해 줘\n`)).toBe(true);
  expect(text).toContain('```java\nint answer = 42;\n```');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v23-notes-write', DIR);

  // 보기: the editor jumps to the written range and marks it.
  await result.getByTestId('note-result-view').click();
  await expect(page.locator('.cm-note-mark--flash').first()).toBeVisible();
  await expect(page.locator('.cm-line').filter({ has: page.locator('.cm-note-mark--flash') }).first()).toContainText('Redis 분산 락 노트로 작성해 줘');

  // 되돌리기 takes it out.
  await result.getByTestId('note-result-revert').click();
  await expect(result.getByTestId('note-result-status')).toHaveText('되돌림');
  await expect(result.getByTestId('note-result-revert')).toHaveCount(0);
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toBe(original);

  // Written again, then one ⌘Z in the editor puts the note back; ⌘⇧Z brings it again.
  await editor.click();
  await page.keyboard.press('Meta+ArrowDown');
  const again = await ask(page, 'Redis 분산 락 노트로 작성해 줘');
  await expect(again.getByTestId('note-result-status')).toHaveText('문서에 반영함');
  await waitSaved(page);
  text = note('Back-End/redis-lock.md');
  expect(text).toContain('### 2. 정리\n\n- fixture 정리입니다.\n');
  await page.locator('.cm-line', { hasText: '둘째 본문.' }).click();
  await page.keyboard.press('Meta+z');
  await expect(editor).not.toContainText('FIXTURE가 스트리밍으로');
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toBe(original);
  await page.keyboard.press('Meta+Shift+z');
  await expect(editor).toContainText('FIXTURE가 스트리밍으로 쓴 본문입니다.');
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toBe(text);
});

test('a document chip opens the viewer: rendered markdown, icon copy, selectable text, Esc closes it (the page stays)', async () => {
  const { app, page } = run;
  const chat = page.getByTestId('note-chat');
  const chip = chat.getByTestId('note-chat-assistant').last().getByTestId('note-doc-chip');
  await chip.click();
  const viewer = page.getByTestId('note-doc-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId('note-doc-title')).toHaveText('Redis 분산 락 노트로 작성해 줘');
  await expect(viewer.locator('.hc-md h1')).toHaveText('Redis 분산 락 노트로 작성해 줘');
  await expect(viewer.locator('.hc-md h3').first()).toHaveText('1. 핵심 개념');
  await expect(viewer.locator('.hc-md pre')).toContainText('int answer = 42;');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v23-notes-viewer', DIR);

  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await expect(viewer.locator('.hc-mdchip')).toHaveCount(0);
  await viewer.getByRole('button', { name: '복사', exact: true }).click();
  await expect(viewer.getByRole('button', { name: '복사됨', exact: true })).toBeVisible();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('# Redis 분산 락 노트로 작성해 줘\n');
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('```java\nint answer = 42;\n```');

  const selected = await dragOver(page, viewer.locator('.hc-md p').first());
  expect(selected).toContain('공부하기 위한 노트입니다');

  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(page.getByTestId('notes-page')).toBeVisible();
  await chip.click();
  await expect(viewer).toBeVisible();
  await viewer.getByTestId('note-doc-close').click();
  await expect(viewer).toHaveCount(0);
});

test('"이거 노트로 작성해 줘" writes the chat answer before it into the note', async () => {
  const { page } = run;
  const saved = note('Back-End/redis-lock.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  const answer = await ask(page, 'RL 커리큘럼 짜 줘');
  await expect(answer.locator('.hc-md table tr')).toHaveCount(7);
  const written = await ask(page, '이거 노트로 작성해 줘');
  await expect(written.getByTestId('note-result-status')).toHaveText('문서에 반영함');
  await waitSaved(page);
  const text = note('Back-End/redis-lock.md');
  expect(text.startsWith(saved.trimEnd())).toBe(true);
  expect(text).toContain('# FIXTURE-NOTE');
  expect(text).toContain('| 6 | Actor-Critic과 PPO | 안정적인 policy 학습 |');
  // Taken back out for the tests after this one.
  await written.getByTestId('note-result-revert').click();
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toBe(saved);
});

test('"2번 섹션 늘려 줘" replaces only that section; a section the note lacks is not written and the chat says why', async () => {
  const { page } = run;
  const before = note('Back-End/redis-lock.md');
  const answer = await ask(page, '2번 섹션 예시 더 넣어서 늘려 줘');
  const result = answer.getByTestId('note-result');
  await expect(result.getByTestId('note-result-target')).toHaveText("섹션 '2. 정리' 교체");
  await expect(result.getByTestId('note-result-status')).toHaveText('문서에 반영함');
  await waitSaved(page);
  const text = note('Back-End/redis-lock.md');
  expect(text).toContain('### 2. 정리\n\nFIXTURE-SECTION: 2번 섹션 예시 더 넣어서 늘려 줘 요청대로 다시 쓴 섹션입니다.\n\n```java\nint example = 1;\n```\n');
  expect(text).not.toContain('- fixture 정리입니다.');
  expect(text).toContain('### 1. 핵심 개념');
  expect(text.slice(0, text.indexOf('### 2. 정리'))).toBe(before.slice(0, before.indexOf('### 2. 정리')));

  // A section the note does not have: nothing is written, the result line says why.
  const missing = (await ask(page, "'없는 섹션' 섹션 고쳐 줘")).getByTestId('note-result');
  await expect(missing).toHaveAttribute('data-status', 'skipped');
  await expect(missing.getByTestId('note-result-status')).toHaveText('반영하지 않음');
  await expect(missing.getByTestId('note-result-error')).toContainText('찾을 수 없습니다');
  await expect(missing.getByTestId('note-result-revert')).toHaveCount(0);
  expect(note('Back-End/redis-lock.md')).toBe(text);

  // The conversation survives reopening the note (answers and their result lines).
  await page.keyboard.press('Meta+p');
  await page.getByTestId('note-quickopen-input').fill('intro');
  await page.getByTestId('note-quickopen-input').press('Enter');
  await expect(page.getByTestId('notes-open-path')).toHaveText('Back-End/intro.md');
  await page.keyboard.press('Meta+p');
  await page.getByTestId('note-quickopen-input').fill('redis');
  await page.getByTestId('note-quickopen-input').press('Enter');
  await expect(page.getByTestId('notes-open-path')).toHaveText('Back-End/redis-lock.md');
  const chat = page.getByTestId('note-chat');
  await expect(chat.locator('[data-testid="note-result"][data-status="applied"]')).toHaveCount(2);
  await expect(chat.locator('[data-testid="note-result"][data-status="reverted"]')).toHaveCount(2);
  await expect(chat.locator('[data-testid="note-result"][data-status="skipped"]')).toHaveCount(1);
  await expect(chat.getByRole('button', { name: '본문에 넣기' })).toHaveCount(0);
});

test('note chat text selects by dragging (user line and answer), with no click sound; the user line and the answer have a copy icon', async () => {
  const { app, page } = run;
  const chat = page.getByTestId('note-chat');
  await page.evaluate(() => {
    (window as unknown as { __hcSoundLog?: unknown[] }).__hcSoundLog = [];
  });
  const user = chat.getByTestId('note-chat-user').filter({ hasText: 'RL 커리큘럼 짜 줘' }).first();
  expect((await dragOver(page, user.locator('.hc-notechat__bubble'))).trim()).toBe('RL 커리큘럼 짜 줘');
  const answer = chat.getByTestId('note-chat-assistant').filter({ hasText: 'FIXTURE-CHAT: RL 커리큘럼 짜 줘' }).first();
  expect(await dragOver(page, answer.locator('.hc-md p').first())).toContain('FIXTURE-CHAT: RL 커리큘럼 짜 줘');
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await page.keyboard.press('Meta+c');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('FIXTURE-CHAT: RL 커리큘럼 짜 줘');
  const log = await page.evaluate(() => (window as unknown as { __hcSoundLog?: { kind: string }[] }).__hcSoundLog ?? []);
  expect(log.filter((e) => e.kind === 'select')).toEqual([]);

  await expect(chat.locator('.hc-mdchip')).toHaveCount(0);
  await user.hover();
  const copy = user.getByRole('button', { name: '복사', exact: true });
  await expect(copy).toBeVisible();
  await expect(copy).toHaveText('');
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await copy.click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('RL 커리큘럼 짜 줘');

  const answerCopy = answer.locator('.hc-notechat__foot').getByRole('button', { name: '복사', exact: true });
  await expect(answerCopy).toBeVisible();
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await answerCopy.click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('FIXTURE-CHAT: RL 커리큘럼 짜 줘');
  await expect(answer.getByRole('button', { name: '복사됨', exact: true })).toBeVisible();
});

test('dragging over text opens the inline prompt; only the selection is replaced and ⌘Z restores it', async () => {
  const { page } = run;
  const before = note('Back-End/redis-lock.md');
  await dragSelect(page, '첫 본문이다.');
  const prompt = page.getByTestId('note-inline');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('선택한 부분을 어떻게 고칠까요?');
  await expect(prompt).toContainText('Claude Code');
  await expect(page.getByTestId('note-inline-input')).toBeFocused();
  await expect(page.locator('.cm-note-mark--pending')).toHaveText('첫 본문이다.');
  await page.getByTestId('note-inline-input').fill('더 자세히');
  await screenshot(page, 'v18-notes-inline', DIR);
  await page.getByTestId('note-inline-input').press('Enter');
  await expect(prompt).toHaveCount(0);
  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('FIXTURE-INLINE: 더 자세히 요청대로 고친 문장입니다.');
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toBe(before.replace('첫 본문이다.', 'FIXTURE-INLINE: 더 자세히 요청대로 고친 문장입니다.'));

  await page.keyboard.press('Meta+z');
  await expect(editor).toContainText('첫 본문이다.');
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toBe(before);

  // ⌘I opens it at the caret; Esc closes it and keeps the page.
  await page.locator('.cm-line', { hasText: '둘째 본문.' }).click();
  await page.keyboard.press('Meta+i');
  await expect(prompt).toContainText('커서 위치에 무엇을 쓸까요?');
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId('notes-page')).toBeVisible();
});

test('Codex: a tool call ends the turn with nothing kept (what streamed into the editor goes back); a normal turn rewrites the note', async () => {
  const { page } = run;
  const chat = page.getByTestId('note-chat');
  await chat.locator('.hc-chip--agent').click();
  const menu = page.getByRole('menu', { name: '에이전트' });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
  await menu.getByRole('menuitemradio', { name: /^Codex/ }).click();
  const saved = note('Back-End/redis-lock.md');
  const failed = await ask(page, '[tool] 전체 정리');
  await expect(chat.locator('.hc-notechat__error')).toContainText('도구를 쓰려고 해서');
  await expect(failed).toContainText('도구를 쓰려고 해서');
  await expect(failed.getByTestId('note-result')).toHaveCount(0);
  await expect(page.getByTestId('notes-page')).not.toContainText('FAKE-SECRET-KEY');
  await expect(page.getByTestId('notes-page')).not.toContainText('CODEX-REWRITE');
  await expect(page.locator('.cm-content')).toContainText('첫 본문이다.');
  expect(note('Back-End/redis-lock.md')).toBe(saved);

  // A question gets a chat answer from Codex too.
  const plain = await ask(page, 'RL 순서 알려 줘');
  await expect(plain.locator('.hc-md table')).toContainText('PPO');
  await expect(plain.getByTestId('note-result')).toHaveCount(0);

  const ok = await ask(page, '전체 정리');
  await expect(ok.getByTestId('note-result-target')).toHaveText('문서 전체 교체');
  await expect(page.locator('.cm-content')).toContainText('CODEX-REWRITE: 전체 정리');
  await waitSaved(page);
  expect(note('Back-End/redis-lock.md')).toContain('CODEX-REWRITE: 전체 정리');
  await ok.getByTestId('note-result-revert').click();
  await waitSaved(page);
  // Back to Claude for the rest of the run.
  await chat.locator('.hc-chip--agent').click();
  await page.getByRole('menu', { name: '에이전트' }).getByRole('menuitemradio', { name: /^Claude Code/ }).click();
  expect(note('Back-End/redis-lock.md')).toBe(saved);
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

test('rename and trash (confirmed) work on files inside the vault, from the drawer', async () => {
  const { page } = run;
  await page.getByTestId('notes-breadcrumb').click();
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
  await page.getByRole('button', { name: '파일 목록 닫기' }).click();
  await expect(page.getByTestId('note-drawer')).toHaveAttribute('aria-hidden', 'true');
});

test('돌아가기 and Esc leave 노트 and unfold the sidebar; coming back reopens the note', async () => {
  const { page } = run;
  await page.getByTestId('notes-back').click();
  await expect(page.getByTestId('notes-page')).toHaveCount(0);
  await expect(page.getByTestId('sidebar')).toHaveAttribute('aria-hidden', 'false');

  await page.getByTestId('sidebar-nav').getByRole('button', { name: '노트', exact: true }).click();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('notes-open-path')).toHaveText('Back-End/redis-lock.md');
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('notes-page')).toHaveCount(0);
  await expect(page.getByTestId('sidebar')).toHaveAttribute('aria-hidden', 'false');
});
