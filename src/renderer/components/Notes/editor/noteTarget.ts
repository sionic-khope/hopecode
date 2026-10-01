// The quiet marker on the range an AI request works on: a soft wash over the text plus a thin yellow bar in the left
// margin of its lines. `pending` while the inline prompt is open over a selection, `busy` while an answer streams in
// (the range grows with it), `flash` for a moment after a card lands. Nothing is drawn otherwise: the editor stays
// clean while the user types.
import { type EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import type { TextRange } from '../../../../core/notes/noteEdit';

export type TargetKind = 'pending' | 'busy' | 'flash';

export interface TargetMark extends TextRange {
  kind: TargetKind;
}

/** Sets (or clears) the marked range. */
export const setTargetRange = StateEffect.define<TargetMark | null>();

function marks(state: EditorState, mark: TargetMark | null): DecorationSet {
  if (!mark) return Decoration.none;
  const docLen = state.doc.length;
  const from = Math.max(0, Math.min(mark.from, docLen));
  const to = Math.max(from, Math.min(mark.to, docLen));
  if (to === from) return Decoration.none;
  const out: Range<Decoration>[] = [];
  const first = state.doc.lineAt(from).number;
  // A range ending at a line start does not mark that line.
  let last = state.doc.lineAt(to).number;
  if (last > first && state.doc.line(last).from === to) last -= 1;
  for (let n = first; n <= last; n++) {
    out.push(Decoration.line({ class: `cm-note-mark-line cm-note-mark-line--${mark.kind}` }).range(state.doc.line(n).from));
  }
  out.push(Decoration.mark({ class: `cm-note-mark cm-note-mark--${mark.kind}` }).range(from, to));
  return Decoration.set(out, true);
}

interface TargetValue {
  mark: TargetMark | null;
  deco: DecorationSet;
}

export const targetField = StateField.define<TargetValue>({
  create: () => ({ mark: null, deco: Decoration.none }),
  update(value, tr) {
    let mark = value.mark;
    if (mark && tr.docChanged) mark = { ...mark, from: tr.changes.mapPos(mark.from, -1), to: tr.changes.mapPos(mark.to, 1) };
    for (const e of tr.effects) if (e.is(setTargetRange)) mark = e.value;
    if (mark === value.mark && !tr.docChanged) return value;
    return { mark, deco: marks(tr.state, mark) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** The marked range right now (mapped through edits), or null. */
export function targetOf(state: EditorState): TargetMark | null {
  return state.field(targetField, false)?.mark ?? null;
}
