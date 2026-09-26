// Fixture-mode (`HOPECODE_FIXTURES=1`, e2e) EditorLauncher: a fixed installed set, and `open` only records.
import type { EditorLauncher } from '../contracts';
import type { EditorId } from '../../shared/types';
import { EDITOR_APPS } from '../editors/editorLauncher';

/** Every `open(editor, dir)` made in fixture mode, in call order (e2e asserts on it). */
export const fixtureEditorOpens: { editor: EditorId; dir: string }[] = [];

const FIXTURE_EDITORS: readonly EditorId[] = ['vscode', 'cursor', 'finder', 'terminal'];

export function createFixtureEditorLauncher(): EditorLauncher {
  return {
    async list() {
      return EDITOR_APPS.filter((e) => FIXTURE_EDITORS.includes(e.id)).map((e) => ({ id: e.id, name: e.name }));
    },
    async open(editor, dir) {
      if (!FIXTURE_EDITORS.includes(editor)) throw new Error(`editor not installed: ${editor}`);
      fixtureEditorOpens.push({ editor, dir });
    },
  };
}
