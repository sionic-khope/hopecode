// "Open in" targets for a thread folder (contracts.ts EditorLauncher): detects installed macOS apps and
// launches them with `open -a` through execFile (no shell, so a folder name can never inject a command).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { EditorLauncher } from '../contracts';
import type { EditorId, EditorInfo } from '../../shared/types';

/** Display order of the "Open in" menu; `app` is the bundle name (`<app>.app`) passed to `open -a`. */
export const EDITOR_APPS: readonly { id: EditorId; name: string; app: string }[] = [
  { id: 'vscode', name: 'Visual Studio Code', app: 'Visual Studio Code' },
  { id: 'cursor', name: 'Cursor', app: 'Cursor' },
  { id: 'zed', name: 'Zed', app: 'Zed' },
  { id: 'xcode', name: 'Xcode', app: 'Xcode' },
  { id: 'finder', name: 'Finder', app: 'Finder' },
  { id: 'terminal', name: 'Terminal', app: 'Terminal' },
  { id: 'iterm', name: 'iTerm', app: 'iTerm' },
  { id: 'ghostty', name: 'Ghostty', app: 'Ghostty' },
];

export interface EditorLauncherDeps {
  exists?: (p: string) => boolean;
  run?: (cmd: string, args: string[]) => Promise<void>;
  homeDir?: string;
}

function runFile(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}

export function createEditorLauncher(deps: EditorLauncherDeps = {}): EditorLauncher {
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? runFile;
  const appDirs = [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    join(deps.homeDir ?? homedir(), 'Applications'),
  ];
  let cached: EditorInfo[] | null = null;

  function detect(): EditorInfo[] {
    if (!cached) {
      cached = EDITOR_APPS.filter((e) => e.id === 'finder' || appDirs.some((dir) => exists(join(dir, `${e.app}.app`)))).map(
        (e) => ({ id: e.id, name: e.name }),
      );
    }
    return cached;
  }

  return {
    async list() {
      return detect();
    },
    async open(editor, dir) {
      if (!isAbsolute(dir)) throw new Error(`folder must be an absolute path: ${dir}`);
      const target = EDITOR_APPS.find((e) => e.id === editor);
      if (!target || !detect().some((e) => e.id === editor)) throw new Error(`editor not installed: ${editor}`);
      if (target.id === 'finder') await run('open', [dir]);
      else await run('open', ['-a', target.app, dir]);
    },
  };
}
