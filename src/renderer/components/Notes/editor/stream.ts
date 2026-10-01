// Streams an inline answer into the editor: the target range is marked and the editor locked while text arrives
// (each piece kept out of the undo history), then the final text lands as one history event, so a single ⌘Z puts the
// note back the way it was before the request.
import { Annotation, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { commitStream, startStream, streamDelta, type StreamState, type TextRange } from '../../../../core/notes/noteEdit';
import { setTargetRange } from './noteTarget';
import { readOnly, readOnlySlot } from './setup';

/** Marks the transactions of a streamed answer (the page does not treat them as typing). */
export const aiChange = Annotation.define<'stream' | 'commit'>();

export class EditorStream {
  private state: StreamState;
  /** Document around the target when the request started (fitAnswer). */
  readonly before: string;
  readonly after: string;
  private ended = false;

  constructor(
    private readonly view: EditorView,
    range: TextRange,
  ) {
    const doc = view.state.doc.toString();
    this.state = startStream(range, doc);
    this.before = doc.slice(0, range.from);
    this.after = doc.slice(range.to);
    view.dispatch({ effects: [readOnlySlot.reconfigure(readOnly(true)), setTargetRange.of({ ...range, kind: 'busy' })] });
  }

  get original(): string {
    return this.state.original;
  }

  get streamed(): string {
    return this.state.streamed;
  }

  delta(text: string): void {
    if (this.ended || !text) return;
    const { change, state } = streamDelta(this.state, text);
    this.state = state;
    const end = state.from + state.shown;
    this.view.dispatch({
      changes: change,
      effects: setTargetRange.of({ from: state.from, to: end, kind: 'busy' }),
      annotations: [Transaction.addToHistory.of(false), aiChange.of('stream')],
    });
    // Keep the growing end in sight while it is near the bottom of the viewport.
    const scroller = this.view.scrollDOM;
    const block = this.view.lineBlockAt(end);
    if (block.bottom > scroller.scrollTop + scroller.clientHeight - 40 && block.top < scroller.scrollTop + scroller.clientHeight + 200) {
      scroller.scrollTop = block.bottom - scroller.clientHeight + 80;
    }
  }

  /** Ends the stream with `final` in place of the original (null = put the original back). */
  finish(final: string | null): void {
    if (this.ended) return;
    this.ended = true;
    const { revert, apply } = commitStream(this.state, final);
    const unlock = [readOnlySlot.reconfigure(readOnly(false)), setTargetRange.of(null)];
    if (revert) this.view.dispatch({ changes: revert, annotations: [Transaction.addToHistory.of(false), aiChange.of('stream')] });
    if (apply) {
      this.view.dispatch({
        changes: apply,
        effects: unlock,
        selection: { anchor: apply.from + apply.insert.length },
        annotations: [aiChange.of('commit'), Transaction.userEvent.of('input.ai'), isolateHistory.of('full')],
        scrollIntoView: true,
      });
    } else {
      this.view.dispatch({ effects: unlock });
    }
  }
}
