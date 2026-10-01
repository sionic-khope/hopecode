// Composer attachments: "파일 첨부" (dialog seam), ⌘V paste, drag & drop (real dropped files through the preload's
// webUtils.getPathForFile), per-agent content blocks (fixture `[blocks]` / fake ACP `/blocks`), refusals, sounds and
// persistence of the sent attachments across a restart. Fixture mode only: nothing reaches a real agent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_PNG_BASE64 } from '../../src/main/fixtures/fakeQuery';
import {
  bootstrapState,
  chooseFixtureFolder,
  createSandbox,
  launch,
  openDraft,
  pickAgent,
  screenshot,
  sendMessage,
  type Launched,
  type Sandbox,
} from './helpers';

const DIR = '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;
let files: { png: string; pdf: string; md: string; exe: string; ts: string };

test.beforeAll(async () => {
  sandbox = createSandbox();
  const dir = join(sandbox.home, 'attach-src');
  mkdirSync(dir, { recursive: true });
  const write = (name: string, data: Buffer | string) => {
    writeFileSync(join(dir, name), data);
    return join(dir, name);
  };
  files = {
    png: write('shot.png', Buffer.from(FIXTURE_PNG_BASE64, 'base64')),
    pdf: write('spec.pdf', '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    md: write('notes.md', '# 회의 메모\n<b>태그는 글자 그대로</b>\n'),
    exe: write('tool.exe', 'MZ\u0000\u0001'),
    ts: write('util.ts', 'export const answer = 42;\n'),
  };
  run = await launch(sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

/** The next "파일 첨부" picks these paths (fixture dialog seam). */
async function setPicked(paths: string[]): Promise<void> {
  await run.app.evaluate((_electron, list) => {
    globalThis.__hopecodeFixturePickFiles = list;
  }, paths);
}

async function attachViaMenu(page: Page): Promise<void> {
  await page.locator('.hc-composer__plus').click();
  await page.getByRole('menuitem', { name: /^파일 첨부/ }).click();
}

const tray = (page: Page) => page.getByTestId('composer-images');
const messages = (page: Page) => page.locator('.hc-messages');

async function sounds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__hcSoundLog ?? []).map((e) => e.kind));
}

test('Claude draft: image + PDF + text via the picker; unsupported file refused inline; blocks reach the session', async () => {
  const { page } = run;
  await openDraft(page);
  await chooseFixtureFolder(page, sandbox);
  await setPicked([files.png, files.pdf, files.md, files.exe]);
  const before = (await sounds(page)).filter((k) => k === 'select').length;
  await attachViaMenu(page);

  await expect(tray(page).locator('.hc-composer-image img')).toHaveAttribute('src', `data:image/png;base64,${FIXTURE_PNG_BASE64}`);
  const chips = tray(page).getByTestId('attachment-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveAttribute('data-kind', 'pdf');
  await expect(chips.nth(0)).toContainText('spec.pdf');
  await expect(chips.nth(0)).toContainText('PDF');
  await expect(chips.nth(1)).toContainText('notes.md');
  await expect(tray(page).getByRole('alert')).toHaveText('tool.exe: .exe 파일은 첨부할 수 없습니다');
  expect((await sounds(page)).filter((k) => k === 'select').length).toBeGreaterThan(before);

  const threads = (await bootstrapState(page)).threads.length;
  await sendMessage(page, '[blocks] 첨부 확인');
  await expect(messages(page)).toContainText(
    'Blocks received: image:image/png, document:base64:application/pdf, document:text:text/plain, text',
  );
  expect((await bootstrapState(page)).threads).toHaveLength(threads + 1);
  await expect(tray(page)).toHaveCount(0);

  const bubble = page.locator('.hc-msg-user__bubble').last();
  await expect(bubble).toContainText('[blocks] 첨부 확인');
  await expect(bubble.getByTestId('user-images').locator('img')).toHaveAttribute('src', `data:image/png;base64,${FIXTURE_PNG_BASE64}`);
  const sent = bubble.getByTestId('user-file-chip');
  await expect(sent).toHaveCount(2);
  await expect(sent.nth(0)).toContainText('spec.pdf');
  await expect(sent.nth(1)).toContainText('notes.md');
});

test('thread composer: picker chips with X (back sound), paste of a text file, screenshot of chips + sent message', async () => {
  const { page } = run;
  await setPicked([files.png, files.ts, files.pdf]);
  await attachViaMenu(page);
  await expect(tray(page).getByTestId('attachment-chip')).toHaveCount(2);

  const backs = (await sounds(page)).filter((k) => k === 'back').length;
  await tray(page).getByRole('button', { name: '첨부 파일 spec.pdf 제거' }).click();
  await expect(tray(page).getByTestId('attachment-chip')).toHaveCount(1);
  expect((await sounds(page)).filter((k) => k === 'back').length).toBe(backs + 1);

  // ⌘V of a file: bytes go to main (attach:paste), typed by name + content like any other file.
  const box = page.locator('.hc-composer__textarea');
  await pasteFile(page, 'clip.txt', '<script>alert(1)</script>\n');
  await expect(tray(page).getByTestId('attachment-chip')).toHaveCount(2);
  await expect(tray(page).getByTestId('attachment-chip').nth(1)).toContainText('clip.txt');
  await box.fill('이 코드도 봐줘');
  await page.mouse.move(10, 10);
  await screenshot(page, 'v15-attach', DIR);

  await box.press('Enter');
  await expect(messages(page)).toContainText('I will update the README greeting.');
  const bubble = page.locator('.hc-msg-user__bubble').last();
  await expect(bubble.getByTestId('user-file-chip')).toHaveCount(2);
  // File content is never rendered (the text with markup stays out of the DOM entirely).
  await expect(page.locator('script', { hasText: 'alert(1)' })).toHaveCount(0);
  await expect(messages(page)).not.toContainText('alert(1)');
  // The fixture's default turn asks to edit README; deny it so the thread goes idle.
  await page.getByRole('button', { name: /거부/ }).first().click();
  await expect(page.locator('.hc-send--stop')).toHaveCount(0);
});

/** Real File objects backed by disk (as a Finder drag gives them), through a throwaway file input. */
async function prepareDrop(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('e2e-drop-source')?.remove();
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'e2e-drop-source';
    input.style.display = 'none';
    document.body.appendChild(input);
  });
  await page.locator('#e2e-drop-source').setInputFiles(paths);
  await page.evaluate(() => {
    const input = document.getElementById('e2e-drop-source') as HTMLInputElement;
    const data = new DataTransfer();
    for (const f of Array.from(input.files ?? [])) data.items.add(f);
    (window as unknown as { __e2eDrop: DataTransfer }).__e2eDrop = data;
    document.querySelector('.hc-composer__card')!.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
}

async function finishDrop(page: Page): Promise<void> {
  await page.locator('.hc-composer__card').evaluate((el) => {
    const data = (window as unknown as { __e2eDrop: DataTransfer }).__e2eDrop;
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
}

async function pasteFile(page: Page, name: string, content: string): Promise<void> {
  await page.locator('.hc-composer__textarea').focus();
  await page.evaluate(
    ({ name, content }) => {
      const data = new DataTransfer();
      data.items.add(new File([content], name, { type: 'text/plain' }));
      document.querySelector('.hc-composer__textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { name, content },
  );
}

test('drag & drop: yellow drop zone while dragging; dropped files become chips', async () => {
  const { page } = run;
  await prepareDrop(page, [files.md, files.png]);
  const zone = page.getByTestId('composer-dropzone');
  await expect(zone).toBeVisible();
  await expect(zone).toHaveText('여기에 놓으면 첨부됩니다');
  expect(await zone.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgb(255, 225, 77)');
  await screenshot(page, 'v15-attach-drop', DIR);
  await finishDrop(page);
  await expect(zone).toHaveCount(0);
  await expect(tray(page).getByTestId('attachment-chip')).toHaveCount(1);
  await expect(tray(page).getByTestId('attachment-chip')).toContainText('notes.md');
  await expect(tray(page).locator('.hc-composer-image img')).toHaveCount(1);
  await tray(page).getByRole('button', { name: '첨부 파일 notes.md 제거' }).click();
  await tray(page).getByRole('button', { name: '첨부 이미지 1 제거' }).click();
  await expect(tray(page)).toHaveCount(0);
});

test('Codex: image + resource blocks reach the agent; a PDF is refused at attach time', async () => {
  const { page } = run;
  await openDraft(page);
  await pickAgent(page, 'Codex');
  await chooseFixtureFolder(page, sandbox);
  await setPicked([files.png, files.md, files.pdf]);
  await attachViaMenu(page);
  await expect(tray(page).locator('.hc-composer-image img')).toHaveCount(1);
  await expect(tray(page).getByTestId('attachment-chip')).toHaveCount(1);
  await expect(tray(page).getByRole('alert')).toHaveText('spec.pdf: Codex은(는) PDF 첨부를 지원하지 않습니다');

  await sendMessage(page, '/blocks');
  await expect(messages(page)).toContainText('BLOCKS image:image/png resource:text:notes.md text');
  const bubble = page.locator('.hc-msg-user__bubble').last();
  await expect(bubble.getByTestId('user-images').locator('img')).toHaveCount(1);
  await expect(bubble.getByTestId('user-file-chip')).toContainText('notes.md');
});

test('Hermes draft: default capabilities refuse images; switching agent re-checks; dropped file goes as resource_link', async () => {
  const { page } = run;
  await openDraft(page);
  await pickAgent(page, 'Claude Code');
  await chooseFixtureFolder(page, sandbox);
  await setPicked([files.png]);
  await attachViaMenu(page);
  await expect(tray(page).locator('.hc-composer-image img')).toHaveCount(1);
  // The image was fine for Claude; Hermes (no image capability before its session reports one) cannot take it.
  await pickAgent(page, 'Hermes');
  const threads = (await bootstrapState(page)).threads.length;
  await sendMessage(page, 'hermes 이미지');
  await expect(tray(page).getByRole('alert')).toContainText('Hermes은(는) 이미지 첨부를 지원하지 않습니다');
  expect((await bootstrapState(page)).threads).toHaveLength(threads);
  await tray(page).getByRole('button', { name: '첨부 이미지 1 제거' }).click();
  await attachViaMenu(page);
  await expect(tray(page).getByRole('alert')).toHaveText('shot.png: Hermes은(는) 이미지 첨부를 지원하지 않습니다');
  await expect(tray(page).locator('.hc-composer-image')).toHaveCount(0);

  // Hermes has no embeddedContext: a text file is only accepted with a path (resource_link). The dropped file is
  // accepted, so preload resolved its real path; the same kind of file pasted (bytes, no path) is refused.
  await prepareDrop(page, [files.md]);
  await finishDrop(page);
  await expect(tray(page).getByTestId('attachment-chip')).toContainText('notes.md');
  await pasteFile(page, 'clip.txt', 'pasted\n');
  await expect(tray(page).getByRole('alert')).toHaveText('clip.txt: Hermes은(는) 붙여넣은 텍스트 파일을 받을 수 없습니다');
  await expect(tray(page).getByTestId('attachment-chip')).toHaveCount(1);
  await sendMessage(page, '/blocks');
  await expect(messages(page)).toContainText('BLOCKS resource_link:notes.md text');
});

test('restart: sent attachments are still shown in the user bubbles', async () => {
  await run.app.close();
  run = await launch(sandbox);
  const { page } = run;
  await page.getByTestId('sidebar').locator('.hc-thread').filter({ hasText: '[blocks] 첨부 확인' }).first().click();
  const bubble = page.locator('.hc-msg-user__bubble').filter({ hasText: '[blocks] 첨부 확인' });
  await expect(bubble.getByTestId('user-images').locator('img')).toHaveAttribute('src', `data:image/png;base64,${FIXTURE_PNG_BASE64}`);
  await expect(bubble.getByTestId('user-file-chip')).toHaveCount(2);
  await expect(bubble.getByTestId('user-file-chip').nth(0)).toContainText('spec.pdf');
  const second = page.locator('.hc-msg-user__bubble').filter({ hasText: '이 코드도 봐줘' });
  await expect(second.getByTestId('user-file-chip')).toHaveCount(2);
  await expect(second.getByTestId('user-file-chip').nth(1)).toContainText('clip.txt');
});
