// Subagent routing (parent_tool_use_id cards + pixel characters) and chat images (tool_result image blocks,
// turn-end gallery, lightbox, composer paste). Fixture markers: `[subagents]`, `[image]`, `[text]`.
import { expect, test } from '@playwright/test';
import { SPRITES, SPRITE_GRID, spriteRects } from '../../src/renderer/components/Subagents/sprites';
import { FIXTURE_PNG_BASE64, FIXTURE_PNG_PATH } from '../../src/main/fixtures/fakeQuery';
import { createSandbox, launch, screenshot, sendMessage, startThread, type Launched, type Sandbox } from './helpers';

const DIR = '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

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

test('[subagents]: two parallel subagent cards, routing line, sprites, expand to child tools, done state', async () => {
  const { page } = run;
  await startThread(page, sandbox, '[subagents] 저장소 조사');
  const messages = page.locator('.hc-messages');
  const cards = messages.getByTestId('subagent-card');
  await expect(cards).toHaveCount(2);
  const routing = messages.getByTestId('subagent-routing');
  await expect(routing).toHaveCount(1);
  // While both run the routing line counts them.
  await expect(routing).toContainText('서브에이전트 2개 실행 중');
  await expect(cards.first().locator('.hc-sprite--running')).toBeVisible();

  await expect(messages).toContainText('두 서브에이전트가 모두 끝났습니다', { timeout: 15_000 });
  await expect(cards.nth(0)).toHaveAttribute('data-state', 'done');
  await expect(cards.nth(1)).toHaveAttribute('data-state', 'done');
  await expect(routing).toContainText('서브에이전트 2개 완료');

  const explore = cards.filter({ hasText: 'Explore' });
  const reviewer = cards.filter({ hasText: 'code-reviewer' });
  await expect(explore).toContainText('README 구조 조사');
  await expect(explore).toContainText('완료');
  await expect(explore.getByTestId('subagent-tool-count')).toHaveText('도구 2');
  await expect(reviewer.getByTestId('subagent-tool-count')).toHaveText('도구 1');
  // One character per card (deterministic per type) with the done badge; child frames stay folded away.
  await expect(explore.locator('.hc-sprite')).toBeVisible();
  await expect(explore.locator('.hc-sprite__badge--done')).toBeVisible();
  await expect(explore.locator('.hc-subagent__header')).toHaveAttribute('aria-expanded', 'false');
  await expect(messages.locator('.hc-tool').filter({ hasText: 'README.md' })).toHaveCount(0);
  // Child tools are not top-level tool cards.
  await expect(messages.locator('.hc-messages__inner > .hc-agent-row .hc-agent-row__body > .hc-tool')).toHaveCount(0);
  await screenshot(page, 'v5-subagents', DIR);

  await explore.locator('.hc-subagent__header').click();
  await expect(explore.locator('.hc-subagent__header')).toHaveAttribute('aria-expanded', 'true');
  const body = explore.locator('.hc-subagent__body');
  await expect(body.locator('.hc-tool')).toHaveCount(2);
  await expect(body.locator('.hc-tool').first()).toContainText('Read');
  await expect(body.locator('.hc-tool').nth(1)).toContainText('Glob');
  await expect(body).toContainText('README는 제목과 인사말 한 줄로 되어 있습니다.');
  await expect(body.locator('.hc-subagent__report')).toContainText('README.md: 제목 + 인사말 한 줄.');
  // The other subagent's calls never leak into this card.
  await expect(body).not.toContainText('Grep');
  await screenshot(page, 'v5-subagents-expanded', DIR);
});

test('[image]: inline tool_result image, turn-end gallery, lightbox with Finder / copy', async () => {
  const { page } = run;
  await sendMessage(page, '[image] 미리보기 만들기');
  const messages = page.locator('.hc-messages');
  await expect(messages).toContainText(`${FIXTURE_PNG_PATH} 이미지를 만들었습니다.`, { timeout: 15_000 });

  const inline = messages.getByTestId('tool-images').getByTestId('image-thumb');
  await expect(inline).toHaveCount(1);
  await expect(inline.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);

  const gallery = messages.getByTestId('image-gallery');
  await expect(gallery).toHaveCount(1);
  await expect(gallery).toContainText('이미지 1개');
  await expect(gallery).toContainText(FIXTURE_PNG_PATH);
  const thumb = gallery.getByTestId('image-thumb');
  await expect(thumb.locator('img')).toHaveAttribute('src', `data:image/png;base64,${FIXTURE_PNG_BASE64}`);
  expect(await thumb.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(48);
  await screenshot(page, 'v5-image', DIR);

  await thumb.click();
  const lightbox = page.getByRole('dialog', { name: FIXTURE_PNG_PATH });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByTestId('image-lightbox').locator('img')).toBeVisible();
  await expect(lightbox.getByRole('button', { name: 'Finder에서 보기' })).toBeVisible();
  await expect(lightbox.getByRole('button', { name: '복사' })).toBeVisible();
  // Finder is a no-op seam in e2e (no window opens); the call still validates the path in main.
  await lightbox.getByRole('button', { name: 'Finder에서 보기' }).click();
  await expect(lightbox.locator('.hc-lightbox__status--error')).toHaveCount(0);
  await screenshot(page, 'v5-lightbox', DIR);
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);

  // Main refuses a path outside the thread folder.
  const refused = await page.evaluate(async () => {
    const threadId = (await window.hopecode.invoke('app:bootstrap')).threads[0]!.id;
    return window.hopecode
      .invoke('image:read', { threadId, path: '../../../../etc/hosts.png' })
      .then(() => 'read')
      .catch(() => 'refused');
  });
  expect(refused).toBe('refused');
});

test('composer: pasted image is attached, sent as an image block and shown in the user bubble', async () => {
  const { page } = run;
  const box = page.locator('.hc-composer__textarea');
  await box.focus();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    document.querySelector('.hc-composer__textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, FIXTURE_PNG_BASE64);
  const tray = page.getByTestId('composer-images');
  await expect(tray.locator('img')).toHaveCount(1);
  await sendMessage(page, '[text] 이 이미지 봐줘');
  await expect(tray).toHaveCount(0);
  const bubble = page.locator('.hc-msg-user__bubble').last();
  await expect(bubble).toContainText('[text] 이 이미지 봐줘');
  await expect(bubble.getByTestId('user-images').locator('img')).toHaveAttribute('src', `data:image/png;base64,${FIXTURE_PNG_BASE64}`);
  await expect(page.locator('.hc-messages')).toContainText('Streaming reply from the fixture session.');
});

test('pixel sprite sheet (every character, running / done / failed)', async () => {
  const { page } = run;
  const sheet = SPRITES.map((s) => ({ id: s.id, name: s.name, rects: spriteRects(s) }));
  await page.evaluate(
    ({ sheet, grid }) => {
      const ns = 'http://www.w3.org/2000/svg';
      const host = document.createElement('div');
      host.id = 'e2e-sprite-sheet';
      host.style.cssText =
        'position:fixed;inset:0;z-index:9999;display:flex;flex-wrap:wrap;align-content:center;justify-content:center;gap:28px;padding:40px;background:var(--bg-window);font:13px var(--font-ui);color:var(--label)';
      const sprite = (rects: (typeof sheet)[number]['rects'], size: number, state: string) => {
        const wrap = document.createElement('span');
        wrap.className = `hc-sprite${state === 'running' ? ' hc-sprite--running' : ''}`;
        wrap.style.cssText = `width:${size}px;height:${size}px;--hc-sprite-px:${size / grid}px`;
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'hc-sprite__svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('viewBox', `0 0 ${grid} ${grid}`);
        svg.setAttribute('shape-rendering', 'crispEdges');
        for (const r of rects) {
          const rect = document.createElementNS(ns, 'rect');
          rect.setAttribute('x', String(r.x));
          rect.setAttribute('y', String(r.y));
          rect.setAttribute('width', String(r.w));
          rect.setAttribute('height', '1');
          rect.setAttribute('fill', r.fill);
          svg.appendChild(rect);
        }
        wrap.appendChild(svg);
        if (state === 'done' || state === 'failed') {
          const badge = document.createElement('span');
          badge.className = `hc-sprite__badge hc-sprite__badge--${state}`;
          badge.innerHTML =
            state === 'done'
              ? '<svg viewBox="0 0 8 8" width="8" height="8"><path d="M1.6 4.2l1.6 1.6 3.2-3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
              : '<svg viewBox="0 0 8 8" width="8" height="8"><path d="M2.4 2.4l3.2 3.2M5.6 2.4l-3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
          wrap.appendChild(badge);
        }
        return wrap;
      };
      for (const s of sheet) {
        const card = document.createElement('div');
        card.style.cssText =
          'display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px 18px;border-radius:12px;background:var(--bg-card);box-shadow:var(--shadow-card)';
        card.appendChild(sprite(s.rects, 96, 'idle'));
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;align-items:center';
        row.append(sprite(s.rects, 24, 'running'), sprite(s.rects, 24, 'done'), sprite(s.rects, 24, 'failed'));
        const label = document.createElement('div');
        label.textContent = `${s.name} · ${s.id}`;
        card.append(row, label);
        host.appendChild(card);
      }
      document.body.appendChild(host);
    },
    { sheet, grid: SPRITE_GRID },
  );
  await expect(page.locator('#e2e-sprite-sheet .hc-sprite')).toHaveCount(SPRITES.length * 4);
  await screenshot(page, 'v5-pixel-sprites', DIR);
  await page.evaluate(() => document.getElementById('e2e-sprite-sheet')?.remove());
});
