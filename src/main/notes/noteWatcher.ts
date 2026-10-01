// Watches the active vault (one recursive fs.watch, FSEvents on macOS) and reports changed paths, debounced.
// Hidden folders (`.git`, temp files of atomic writes) are ignored, so a commit or the app's own save of a temp file
// does not refresh the tree by itself; the rename onto the note does.
import { watch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';
import type { NoteChange } from '../../shared/notes';
import { isHiddenNoteName } from '../../core/notes/notePaths';

export const NOTE_WATCH_DEBOUNCE_MS = 300;
/** Paths reported per event at most; more = `all: true`. */
export const MAX_REPORTED = 200;

export interface NoteWatcher {
  /** Watches `vault` (null = stop). Watching the same folder again is a no-op. */
  set(vault: string | null): void;
  dispose(): void;
}

export function createNoteWatcher(onChange: (change: NoteChange) => void, log: (message: string, err?: unknown) => void): NoteWatcher {
  let current: { vault: string; watcher: FSWatcher } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = new Set<string>();
  let all = false;

  const flush = () => {
    timer = null;
    if (!current) return;
    const paths = [...pending];
    const change: NoteChange = { vault: current.vault, paths: all ? [] : paths.slice(0, MAX_REPORTED), all: all || paths.length > MAX_REPORTED };
    pending = new Set();
    all = false;
    onChange(change);
  };

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = new Set();
    all = false;
    current?.watcher.close();
    current = null;
  };

  return {
    set(vault) {
      if (current?.vault === vault) return;
      stop();
      if (!vault) return;
      try {
        const watcher = watch(vault, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename === null) all = true;
          else if (!all) {
            const rel = String(filename).split(sep).join('/');
            if (rel.split('/').some(isHiddenNoteName)) return;
            pending.add(rel);
            // A burst (checkout, sync) is reported as one full refresh; the set never grows past the cap.
            if (pending.size > MAX_REPORTED) all = true;
          }
          if (all) pending.clear();
          if (!timer) timer = setTimeout(flush, NOTE_WATCH_DEBOUNCE_MS);
        });
        watcher.on('error', (err) => {
          log('[notes] vault watch failed', err);
          if (current?.watcher === watcher) stop();
        });
        current = { vault, watcher };
      } catch (err) {
        log('[notes] vault watch could not start', err);
      }
    },
    dispose: stop,
  };
}
