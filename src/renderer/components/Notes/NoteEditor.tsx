import { memo, useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreview } from './editor/livePreview';
import { setTargetRange, sectionTrackerSlot, sectionTracking } from './editor/noteTarget';
import { livePreviewSlot, noteExtensions } from './editor/setup';
import { aiChange } from './editor/stream';

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

export interface NoteEditorProps {
  handleRef: Ref<NoteEditorHandle>;
  /** Live Preview (false = plain source). */
  live: boolean;
  /** Frame the "이 섹션" target that follows the caret. */
  sectionTracking: boolean;
  /** The user changed the text (AI stream transactions are not reported until the final commit). */
  onEdit: () => void;
  onSave: () => void;
  /** The page is leaving: the last text, before the view is destroyed (pending autosave). */
  onDispose?: (text: string) => void;
  hidden?: boolean;
}

/** CodeMirror host of the notes page. The view lives as long as the page; files swap its state. */
export const NoteEditor = memo(function NoteEditor({ handleRef, live, sectionTracking: tracking, onEdit, onSave, onDispose, hidden }: NoteEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const hooks = useRef({ onEdit, onSave, onDispose });
  hooks.current = { onEdit, onSave, onDispose };
  const opts = useRef({ live, tracking });
  opts.current = { live, tracking };

  const makeState = (text: string) =>
    EditorState.create({
      doc: text,
      extensions: [
        noteExtensions({ onSave: () => hooks.current.onSave() }, { live: opts.current.live, sectionTracking: opts.current.tracking }),
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
    return () => {
      hooks.current.onDispose?.(view.state.doc.toString());
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; files swap its state through the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: livePreviewSlot.reconfigure(live ? livePreview() : []) });
  }, [live]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [sectionTrackerSlot.reconfigure(sectionTracking(tracking)), ...(tracking ? [] : [setTargetRange.of(null)])],
    });
  }, [tracking]);

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
