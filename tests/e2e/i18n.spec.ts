// v22: UI language. 설정 > 일반 > 언어 switches renderer and main (app menu) at once, without a restart; the choice is
// stored in settings.language and survives a relaunch; 'system' follows the OS locale (HOPECODE_SYSTEM_LOCALE stands in
// for app.getLocale() in fixture runs). Every other spec runs with the locale pinned to ko-KR (helpers.launch).
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createSandbox, launch, menuShortcut, screenshot, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

interface Expected {
  /** `<html lang>` */
  lang: string;
  /** Native name in the language menu. */
  option: string;
  settingsTitle: string;
  newChat: string;
  prs: string;
  placeholder: string;
  menuFile: string;
  menuNewChat: string;
  shot: string;
}

const LANGS: readonly Expected[] = [
  {
    lang: 'en',
    option: 'English',
    settingsTitle: 'Settings',
    newChat: 'New Chat',
    prs: 'Pull Requests',
    placeholder: 'Ask for anything',
    menuFile: 'File',
    menuNewChat: 'New Chat',
    shot: 'en',
  },
  {
    lang: 'ja',
    option: '日本語',
    settingsTitle: '設定',
    newChat: '新規チャット',
    prs: 'プルリクエスト',
    placeholder: '何でも頼んでください',
    menuFile: 'ファイル',
    menuNewChat: '新規チャット',
    shot: 'ja',
  },
  {
    lang: 'zh-Hans',
    option: '简体中文',
    settingsTitle: '设置',
    newChat: '新建对话',
    prs: '拉取请求',
    placeholder: '有什么需要尽管说',
    menuFile: '文件',
    menuNewChat: '新建对话',
    shot: 'zh',
  },
];

/** Top-level menu labels and the label of the item behind ⌘N, read straight from main's application menu. */
async function appMenu(app: ElectronApplication): Promise<{ top: string[]; newChat: string | null }> {
  return app.evaluate(({ Menu }) => {
    type Item = { label: string; accelerator?: string | null; submenu?: { items: Item[] } | null };
    const items = (Menu.getApplicationMenu()?.items ?? []) as unknown as Item[];
    const find = (list: Item[]): Item | undefined => {
      for (const item of list) {
        if (item.accelerator === 'CmdOrCtrl+N') return item;
        const nested = item.submenu ? find(item.submenu.items) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    return { top: items.map((i) => i.label), newChat: find(items)?.label ?? null };
  });
}

async function pickLanguage(page: Page, option: string): Promise<void> {
  await page.getByTestId('settings-language').click();
  await page.getByRole('menuitemradio', { name: option, exact: true }).click();
}

async function expectLanguage(app: ElectronApplication, page: Page, e: Expected): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', e.lang);
  await expect(page.locator('.hc-settings__title')).toHaveText(e.settingsTitle);
  const nav = page.getByTestId('sidebar-nav');
  await expect(nav).toContainText(e.newChat);
  await expect(nav).toContainText(e.prs);
  await expect.poll(async () => (await appMenu(app)).top).toContain(e.menuFile);
  await expect.poll(async () => (await appMenu(app)).newChat).toBe(e.menuNewChat);
}

let sandbox: Sandbox;

test.beforeEach(() => {
  sandbox = createSandbox();
});

test.afterEach(() => {
  sandbox?.cleanup();
});

test('settings switch the language live: sidebar, composer, settings and the app menu follow', async () => {
  const { app, page } = await launch(sandbox);
  try {
    // Baseline (e2e locale ko-KR, language 'system').
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    expect((await appMenu(app)).top).toContain('파일');
    await menuShortcut(app, 'CmdOrCtrl+,');
    await expect(page.getByTestId('settings')).toBeVisible();
    await expect(page.getByTestId('settings-language')).toContainText('시스템 설정 (한국어)');

    for (const e of LANGS) {
      await pickLanguage(page, e.option);
      await expectLanguage(app, page, e);
      await screenshot(page, `v22-i18n-${e.shot}`, SHOTS);
      // The draft composer outside settings is translated too; then back to settings for the next switch.
      await menuShortcut(app, 'CmdOrCtrl+N');
      await expect(page.locator('.hc-composer__textarea')).toHaveAttribute('placeholder', e.placeholder);
      await menuShortcut(app, 'CmdOrCtrl+,');
      await expect(page.getByTestId('settings')).toBeVisible();
    }

    // Back to Korean: the strings every other spec relies on come back.
    await pickLanguage(page, '한국어');
    await expect(page.locator('.hc-settings__title')).toHaveText('설정');
    await expect.poll(async () => (await appMenu(app)).newChat).toBe('새 채팅');
  } finally {
    await app.close();
  }
});

test('the chosen language is stored and survives a relaunch', async () => {
  const first = await launch(sandbox);
  try {
    await menuShortcut(first.app, 'CmdOrCtrl+,');
    await pickLanguage(first.page, '日本語');
    await expect(first.page.locator('html')).toHaveAttribute('lang', 'ja');
    const stored = await first.page.evaluate(async () => {
      const boot = (await window.hopecode.invoke('app:bootstrap')) as { settings: { language: string } };
      return boot.settings.language;
    });
    expect(stored).toBe('ja');
  } finally {
    await first.app.close();
  }

  // Same HOPECODE_HOME, the OS locale still ko-KR: the stored choice wins.
  const second = await launch(sandbox);
  try {
    await expect(second.page.locator('html')).toHaveAttribute('lang', 'ja');
    await menuShortcut(second.app, 'CmdOrCtrl+,');
    await expectLanguage(second.app, second.page, LANGS[1]!);
  } finally {
    await second.app.close();
  }
});

test("'system' maps the OS locale to the closest language, English when none fits", async () => {
  const zh = await launch(sandbox, { env: { HOPECODE_SYSTEM_LOCALE: 'zh-TW' } });
  try {
    await menuShortcut(zh.app, 'CmdOrCtrl+,');
    await expectLanguage(zh.app, zh.page, LANGS[2]!);
    await expect(zh.page.getByTestId('settings-language')).toContainText('跟随系统（简体中文）');
  } finally {
    await zh.app.close();
  }

  const other = createSandbox();
  const fr = await launch(other, { env: { HOPECODE_SYSTEM_LOCALE: 'fr-FR' } });
  try {
    await menuShortcut(fr.app, 'CmdOrCtrl+,');
    await expectLanguage(fr.app, fr.page, LANGS[0]!);
    await expect(fr.page.getByTestId('settings-language')).toContainText('System (English)');
  } finally {
    await fr.app.close();
    other.cleanup();
  }
});
