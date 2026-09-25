// R2 per-thread terminal state survives thread switches; T7 threads + transcript survive a restart and the
// next send resumes the same SDK session.
import { expect, test, type Page } from '@playwright/test';
import {
  bootstrapState,
  createSandbox,
  launch,
  menuShortcut,
  screenshot,
  sendMessage,
  startThread,
  type Sandbox,
} from './helpers';

async function terminalText(page: Page): Promise<string> {
  return ((await page.getByTestId('terminal').locator('.xterm-rows').textContent()) ?? '').replace(/\s+/g, '');
}

test('terminal shell state is kept per thread across thread switches', async () => {
  const sandbox = createSandbox();
  const { app, page } = await launch(sandbox);
  try {
    await startThread(page, sandbox, '[text] thread A');
    await startThread(page, sandbox, '[text] thread B');
    const threads = page.getByTestId('sidebar').locator('.hc-thread');
    await expect(threads).toHaveCount(2);

    await threads.nth(0).click();
    await menuShortcut(app, 'CmdOrCtrl+J');
    await page.getByTestId('terminal').locator('.xterm').click();
    await page.keyboard.type('export HOPECODE_X=1; echo "SET=[$HOPECODE_X]"\n');
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).toContain('SET=[1]');

    await threads.nth(1).click();
    await page.getByTestId('terminal').locator('.xterm').click();
    await page.keyboard.type('echo "B=[${HOPECODE_X:-unset}]"\n');
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).toContain('B=[unset]');

    await threads.nth(0).click();
    await page.getByTestId('terminal').locator('.xterm').click();
    await page.keyboard.type('echo "BACK=[$HOPECODE_X]"\n');
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).toContain('BACK=[1]');
    // Scrollback from before the switch is still there.
    expect(await terminalText(page)).toContain('SET=[1]');
    await screenshot(page, '11-terminal-per-thread');
  } finally {
    await app.close();
    sandbox.cleanup();
  }
});

test('threads and transcript survive a restart; the next send resumes the session', async () => {
  const sandbox = createSandbox();
  try {
    let sessionId: string | null = null;
    {
      const { app, page } = await launch(sandbox);
      await startThread(page, sandbox, '[text] remember this');
      await expect(page.locator('.hc-messages')).toContainText('Streaming reply from the fixture session.');
      const state = (await bootstrapState(page)) as unknown as { threads: { sdkSessionId: string | null }[] };
      sessionId = state.threads[0].sdkSessionId;
      expect(sessionId).toBeTruthy();
      await app.close();
    }
    {
      const { app, page } = await launch(sandbox);
      try {
        const sidebar = page.getByTestId('sidebar');
        await expect(sidebar.locator('.hc-project')).toHaveCount(1);
        await expect(sidebar.locator('.hc-thread')).toHaveCount(1);
        await sidebar.locator('.hc-thread').first().click();
        const messages = page.locator('.hc-messages');
        await expect(messages.locator('.hc-msg-user__bubble')).toHaveText('[text] remember this');
        await expect(messages).toContainText('Streaming reply from the fixture session.');
        await screenshot(page, '12-restart-restored');

        await sendMessage(page, '[whoami] after restart');
        await expect(messages).toContainText(`resume=${sessionId}`);
        await expect(messages).toContainText('account=fixture-personal');
      } finally {
        await app.close();
      }
    }
  } finally {
    sandbox.cleanup();
  }
});
