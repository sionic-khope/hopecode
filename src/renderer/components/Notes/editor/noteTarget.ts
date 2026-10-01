// The yellow frame around the range a note AI request works on: the heading section at the caret (or at the top of
// the viewport once the caret scrolled away) while "이 섹션" is selected, and the live range while an answer streams.
import { Compartment, type EditorState, type Extension, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { sectionRange, type TextRange } from '../../../../core/notes/noteEdit';

/** Sets (or clears) the framed range. */
export const setTargetRange = StateEffect.define<TextRange | null>();

function frame(state: EditorState, range: TextRange | null): DecorationSet {
  if (!range) return Decoration.none;
  const docLen = state.doc.length;
  const from = Math.max(0, Math.min(range.from, docLen));
  const to = Math.max(from, Math.min(range.to, docLen));
  const first = state.doc.lineAt(from).number;
  // A range ending at a line start (the next section's heading) does not frame that line.
  let last = state.doc.lineAt(to).number;
  if (last > first && state.doc.line(last).from === to) last -= 1;
  const out: Range<Decoration>[] = [];
  for (let n = first; n <= last; n++) {
    const cls = ['cm-note-target', n === first ? 'cm-note-target--first' : '', n === last ? 'cm-note-target--last' : ''].filter(Boolean).join(' ');
    out.push(Decoration.line({ class: cls }).range(state.doc.line(n).from));
  }
  return Decoration.set(out);
}

interface TargetValue {
  range: TextRange | null;
  deco: DecorationSet;
}

export const targetField = StateField.define<TargetValue>({
  create: () => ({ range: null, deco: Decoration.none }),
  update(value, tr) {
    let range = value.range;
    if (range && tr.docChanged) range = { from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) };
    for (const e of tr.effects) if (e.is(setTargetRange)) range = e.value;
    if (range === value.range && !tr.docChanged) return value;
    return { range, deco: frame(tr.state, range) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Position the "이 섹션" target is computed from: the caret when it is on screen, else the first visible line. */
export function targetAnchor(view: EditorView): number {
  const head = view.state.selection.main.head;
  const scroller = view.scrollDOM;
  const top = scroller.scrollTop;
  const bottom = top + scroller.clientHeight;
  const block = view.lineBlockAt(head);
  if (block.bottom >= top && block.top <= bottom) return head;
  return view.lineBlockAtHeight(Math.max(0, top - view.documentPadding.top)).from;
}

/** The "이 섹션" range for the view right now (a non-empty selection wins). */
export function currentSection(view: EditorView): TextRange {
  const sel = view.state.selection.main;
  const r = sectionRange(view.state.doc.toString(), targetAnchor(view), sel.empty ? null : { from: sel.from, to: sel.to });
  return { from: r.from, to: r.to };
}

/** Follows the caret / scroll position and frames its section (on while "이 섹션" is the request mode). */
const sectionTracker = ViewPlugin.fromClass(
  class {
    private frameId = 0;
    private last: TextRange | null = null;
    constructor(private readonly view: EditorView) {
      this.schedule();
      this.onScroll = this.onScroll.bind(this);
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    }
    onScroll() {
      this.schedule();
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.geometryChanged) this.schedule();
    }
    schedule() {
      if (this.frameId) return;
      this.frameId = requestAnimationFrame(() => {
        this.frameId = 0;
        if (this.view.state.readOnly) return;
        const range = currentSection(this.view);
        if (this.last && this.last.from === range.from && this.last.to === range.to) return;
        this.last = range;
        this.view.dispatch({ effects: setTargetRange.of(range) });
      });
    }
    destroy() {
      cancelAnimationFrame(this.frameId);
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    }
  },
);

/** Holds the tracker while "이 섹션" is selected (empty otherwise). */
export const sectionTrackerSlot = new Compartment();

export function sectionTracking(on: boolean): Extension {
  return on ? sectionTracker : [];
}
