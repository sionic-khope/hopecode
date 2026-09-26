import { describe, expect, it } from 'vitest';
import { EDITOR_APPS, createEditorLauncher } from '../../src/main/editors/editorLauncher';
import { createFixtureEditorLauncher, fixtureEditorOpens } from '../../src/main/fixtures/fixtureEditors';

function fakes(installed: string[]) {
  const checked: string[] = [];
  const runs: { cmd: string; args: string[] }[] = [];
  const launcher = createEditorLauncher({
    homeDir: '/Users/tester',
    exists: (p) => {
      checked.push(p);
      return installed.includes(p);
    },
    run: async (cmd, args) => {
      runs.push({ cmd, args });
    },
  });
  return { launcher, checked, runs };
}

describe('editorLauncher', () => {
  it('lists installed apps in display order, always including Finder, and caches', async () => {
    const { launcher, checked } = fakes([
      '/Users/tester/Applications/Cursor.app',
      '/Applications/Visual Studio Code.app',
      '/System/Applications/Utilities/Terminal.app',
      '/Applications/iTerm.app',
    ]);
    const list = await launcher.list();
    expect(list).toEqual([
      { id: 'vscode', name: 'Visual Studio Code' },
      { id: 'cursor', name: 'Cursor' },
      { id: 'finder', name: 'Finder' },
      { id: 'terminal', name: 'Terminal' },
      { id: 'iterm', name: 'iTerm' },
    ]);
    const calls = checked.length;
    await launcher.list();
    expect(checked.length).toBe(calls);
  });

  it('opens with open -a (Finder: plain open) and never through a shell', async () => {
    const { launcher, runs } = fakes(['/Applications/Visual Studio Code.app']);
    await launcher.open('vscode', '/tmp/my project');
    await launcher.open('finder', '/tmp/my project');
    expect(runs).toEqual([
      { cmd: 'open', args: ['-a', 'Visual Studio Code', '/tmp/my project'] },
      { cmd: 'open', args: ['/tmp/my project'] },
    ]);
  });

  it('rejects uninstalled editors and relative folders', async () => {
    const { launcher, runs } = fakes([]);
    await expect(launcher.open('zed', '/tmp')).rejects.toThrow(/not installed/);
    await expect(launcher.open('finder', 'relative/dir')).rejects.toThrow(/absolute/);
    expect(runs).toEqual([]);
  });

  it('EDITOR_APPS keeps the menu order', () => {
    expect(EDITOR_APPS.map((e) => e.id)).toEqual(['vscode', 'cursor', 'zed', 'xcode', 'finder', 'terminal', 'iterm', 'ghostty']);
  });

  it('fixture launcher lists a fixed set and only records opens', async () => {
    const launcher = createFixtureEditorLauncher();
    expect((await launcher.list()).map((e) => e.id)).toEqual(['vscode', 'cursor', 'finder', 'terminal']);
    const before = fixtureEditorOpens.length;
    await launcher.open('cursor', '/tmp/x');
    expect(fixtureEditorOpens.slice(before)).toEqual([{ editor: 'cursor', dir: '/tmp/x' }]);
    await expect(launcher.open('zed', '/tmp/x')).rejects.toThrow();
  });
});
