// UI sounds (headless): the top-right speaker toggle and its persisted state, voice blips from a live streaming reply
// (none inside the code block, none for a history load), menu move / select / back, and silence when turned off.
// Test runs never create an AudioContext: the engine only records into window.__hcSoundLog.
import { expect, test, type Page } from '@playwright/test';
import { createSandbox, launch, screenshot, sendMessage, startThread, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

/** The fixture's `[code]` reply (src/main/fixtures/fakeQuery.ts). */
const CODE_REPLY =
  'Here is the helper:\n\n```ts\nexport function greet(name: string): string {\n  return `Hello ${name}`;\n}\n```\n\nCall it with your name.';

interface LogEntry {
  kind: string;
  agent?: string;
  itemId?: string;
  pos?: number;
}

const toggle = (page: Page) => page.getByRole('toolbar', { name: '스레드 도구' }).getByTestId('sound-toggle');

async function soundLog(page: Page): Promise<LogEntry[]> {
  return page.evaluate(() => (window as unknown as { __hcSoundLog?: LogEntry[] }).__hcSoundLog ?? []);
}

async function clearLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __hcSoundLog?: unknown[] }).__hcSoundLog = [];
  });
}

/** Any AudioContext the app tries to create is counted (and refused). */
async function trapAudioContext(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { AudioContext: unknown; __hcAudioContexts: number };
    w.__hcAudioContexts = 0;
    w.AudioContext = function () {
      w.__hcAudioContexts++;
      throw new Error('no AudioContext in e2e');
    };
  });
}

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;

test.beforeAll(() => {
  sandbox = createSandbox();
});

test.afterAll(() => {
  sandbox?.cleanup();
});

test('top-right toggle, live voice without code, menu cues, silent history, off persists', async () => {
  let threadTitle = '';
  {
    const { app, page } = await launch(sandbox);
    try {
      await trapAudioContext(page);
      // Toggle: top-right corner of the window, on by default.
      const btn = toggle(page);
      await expect(btn).toBeVisible();
      await expect(btn).toHaveAttribute('aria-label', '사운드 끄기');
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
      await expect(btn.locator('[data-glyph="sound-on"]')).toHaveCount(1);
      const box = (await btn.boundingBox())!;
      const width = await page.evaluate(() => window.innerWidth);
      expect(box.x + box.width).toBeGreaterThan(width - 80);
      expect(box.y).toBeLessThan(60);
      await screenshot(page, 'v13-sound-toggle', SHOTS);

      // Live reply in the thread on screen: voice blips, none inside the ``` block; a send cue and nothing at turn end.
      threadTitle = '[code] first';
      await startThread(page, sandbox, threadTitle);
      await expect(page.locator('.hc-messages')).toContainText('Call it with your name.');
      await clearLog(page);
      await sendMessage(page, '[code] again');
      await expect(page.locator('.hc-messages .hc-msg-user__bubble').last()).toHaveText('[code] again');
      await expect(page.locator('.hc-messages')).toContainText('Call it with your name.');
      await expect.poll(async () => (await soundLog(page)).some((e) => e.kind === 'voice')).toBe(true);
      await page.waitForTimeout(400);
      const log = await soundLog(page);
      expect(log.some((e) => e.kind === 'done')).toBe(false);
      expect(log.some((e) => e.kind === 'send')).toBe(true);
      const voice = log.filter((e) => e.kind === 'voice');
      expect(voice.length).toBeGreaterThan(0);
      expect(voice.every((e) => e.agent === 'claude-code')).toBe(true);
      const fenceStart = CODE_REPLY.indexOf('```');
      const fenceEnd = CODE_REPLY.lastIndexOf('```') + 3;
      for (const e of voice) {
        expect(e.pos! < fenceStart || e.pos! >= fenceEnd, `voice at ${e.pos} inside the code block`).toBe(true);
        expect(CODE_REPLY[e.pos!]).toMatch(/[A-Za-z]/);
      }

      // Menu: keyboard move, Escape = back (and no select for it), click = select.
      await clearLog(page);
      const more = page.getByRole('toolbar', { name: '스레드 도구' }).getByRole('button', { name: '더보기' });
      await more.click();
      const menu = page.getByRole('menu', { name: '더보기' });
      await expect(menu).toBeVisible();
      await expect.poll(() => menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      const kinds = (await soundLog(page)).map((e) => e.kind);
      expect(kinds).toEqual(['select', 'move', 'back']);
      expect(await page.evaluate(() => (window as unknown as { __hcAudioContexts: number }).__hcAudioContexts)).toBe(0);
    } finally {
      await app.close();
    }
  }

  {
    // History load after a restart: the reply is shown, nothing speaks. Then sound off: nothing is recorded.
    const { app, page } = await launch(sandbox);
    try {
      await trapAudioContext(page);
      await clearLog(page);
      await page.getByTestId('sidebar').locator('.hc-thread').filter({ hasText: threadTitle }).click();
      await expect(page.locator('.hc-messages')).toContainText('Call it with your name.');
      await page.waitForTimeout(300);
      expect((await soundLog(page)).filter((e) => e.kind === 'voice')).toEqual([]);

      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
      await expect(toggle(page)).toHaveAttribute('aria-label', '사운드 켜기');
      await expect(toggle(page).locator('[data-glyph="sound-off"]')).toHaveCount(1);
      await clearLog(page);
      await sendMessage(page, '[code] silent');
      await expect(page.locator('.hc-messages .hc-msg-user__bubble').last()).toHaveText('[code] silent');
      // Third `[code]` reply of the thread (two came from the first launch).
      await expect(page.locator('.hc-messages').getByText('Call it with your name.')).toHaveCount(3);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      expect(await soundLog(page)).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __hcAudioContexts: number }).__hcAudioContexts)).toBe(0);
    } finally {
      await app.close();
    }
  }

  {
    // The off state survives a restart (settings), in the toolbar and in 설정.
    const { app, page } = await launch(sandbox);
    try {
      await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
      await expect(toggle(page)).toHaveAttribute('aria-label', '사운드 켜기');
      const settings = await page.evaluate(() => window.hopecode.invoke('app:bootstrap'));
      expect((settings as { settings: { soundEnabled: boolean } }).settings.soundEnabled).toBe(false);
    } finally {
      await app.close();
    }
  }
});
