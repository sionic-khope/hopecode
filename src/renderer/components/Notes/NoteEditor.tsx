import { memo, useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { noteExtensions } from './editor/setup';
import { aiChange } from './editor/stream';
import { useLanguage } from '../../i18n';

export interface NoteEditorHandle {
  view(): EditorView | null;
  /** New document with a fresh undo history (opening a file). */
  load(text: string): void;
  /** Replaces the text without an undo step (the file changed on disk). */
  replace(text: string): void;
  /** null once the view is gone. */
  text(): string | null;
  focus(): void;
}

/** Pointer travel (px) that makes a press-and-release a drag selection rather than a click. */
const DRAG_MIN_PX = 4;

export interface NoteEditorProps {
  handleRef: Ref<NoteEditorHandle>;
  /** The user changed the text (AI stream transactions are not reported until the final commit). */
  onEdit: () => void;
  onSave: () => void;
  /** ⌘I in the editor. */
  onInlinePrompt: () => void;
  /** A pointer drag ended with text selected (single click-drag; double / triple click selections do not count). */
  onDragSelect: () => void;
  /** A press inside the editor (closes the inline prompt). */
  onPress: () => void;
  /** The page is leaving: the last text, before the view is destroyed (pending autosave). */
  onDispose?: (text: string) => void;
  hidden?: boolean;
}

/** CodeMirror host of the notes page (always Live Preview). The view lives as long as the page; files swap its state. */
export const NoteEditor = memo(function NoteEditor({ handleRef, onEdit, onSave, onInlinePrompt, onDragSelect, onPress, onDispose, hidden }: NoteEditorProps) {
  useLanguage();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const hooks = useRef({ onEdit, onSave, onDispose, onInlinePrompt, onDragSelect, onPress });
  hooks.current = { onEdit, onSave, onDispose, onInlinePrompt, onDragSelect, onPress };

  const makeState = (text: string) =>
    EditorState.create({
      doc: text,
      extensions: [
        noteExtensions({ onSave: () => hooks.current.onSave(), onInlinePrompt: () => hooks.current.onInlinePrompt() }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const ai = u.transactions.map((tr) => tr.annotation(aiChange)).find(Boolean);
          const external = u.transactions.some((tr) => tr.annotation(Transaction.remote));
          if (ai === 'stream' || external) return;
          hooks.current.onEdit();
        }),
      ],
    });

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({ state: makeState(''), parent: host.current });
    viewRef.current = view;
    // Drag selection: remember where a single-click press started; on release anywhere, a moved pointer with a
    // non-empty selection opens the inline prompt.
    let press: { x: number; y: number } | null = null;
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      hooks.current.onPress();
      press = e.detail === 1 && !e.shiftKey && !e.metaKey ? { x: e.clientX, y: e.clientY } : null;
    };
    const up = (e: MouseEvent) => {
      const start = press;
      press = null;
      if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_MIN_PX) return;
      // Let CodeMirror settle the selection from this release first.
      requestAnimationFrame(() => {
        const v = viewRef.current;
        if (v && !v.state.selection.main.empty && !v.state.readOnly) hooks.current.onDragSelect();
      });
    };
    view.contentDOM.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    return () => {
      view.contentDOM.removeEventListener('mousedown', down);
      window.removeEventListener('mouseup', up);
      hooks.current.onDispose?.(view.state.doc.toString());
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; files swap its state through the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      view: () => viewRef.current,
      load(text) {
        viewRef.current?.setState(makeState(text));
      },
      replace(text) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
        });
      },
      text: () => viewRef.current?.state.doc.toString() ?? null,
      focus: () => viewRef.current?.focus(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return <div ref={host} className="hc-note-editor" data-testid="note-editor" hidden={hidden} />;
});
