// Native window-drag regions vs. clickable controls. In the real window a control whose computed
// -webkit-app-region is `drag` (e.g. a button styled with `all: unset` inside a drag bar) drags the window instead of
// receiving the click; synthetic test clicks bypass the native hit test, so this asserts the computed style instead.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createSandbox, launch, openFromMore, type Launched, type Sandbox } from './helpers';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let vault: string;
let run: Launched;

test.beforeAll(async () => {
  sandbox = createSandbox();
  vault = mkdtempSync(join(tmpdir(), 'deltax-e2e-drag-'));
  mkdirSync(join(vault, 'A'), { recursive: true });
  writeFileSync(join(vault, 'A', 'x.md'), '# x\n');
  run = await launch(sandbox, { env: { HOPECODE_FIXTURE_NOTES: vault } });
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
  if (vault) rmSync(vault, { recursive: true, force: true });
});

/** Visible controls whose computed app-region is `drag`. */
function draggingControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"]'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'drag';
      })
      .map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className} ${el.getAttribute('aria-label') ?? ''}`.trim()),
  );
}

test('no clickable control is a window-drag region (chat, settings, notes)', async () => {
  const { page } = run;
  expect(await draggingControls(page)).toEqual([]);
  await openFromMore(page, '설정');
  expect(await draggingControls(page)).toEqual([]);
  await page.getByTestId('sidebar-nav').getByRole('button', { name: '노트', exact: true }).click();
  await expect(page.getByTestId('notes-back')).toBeVisible();
  expect(await draggingControls(page)).toEqual([]);
  await expect(page.getByTestId('notes-back')).toHaveCSS('-webkit-app-region', 'no-drag');
});
