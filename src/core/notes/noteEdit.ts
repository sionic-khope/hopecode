// 노트 모드 editor math, independent of CodeMirror (pure, unit-tested): the heading section around the caret, the
// changes that stream an answer into a range, and how the final answer is fitted into the document.
import type { NoteAiMode } from '../../shared/notes';

export interface TextRange {
  from: number;
  to: number;
}

export interface SectionRange extends TextRange {
  /** Heading level of the section (0 = the text before the first heading, or a selection). */
  level: number;
  /** Heading text without the `#` marks ('' when there is none). */
  title: string;
}

interface HeadingLine {
  start: number;
  level: number;
  title: string;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t#]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** ATX headings outside fenced code blocks, in document order. */
export function headingLines(text: string): HeadingLine[] {
  const out: HeadingLine[] = [];
  let fence: string | null = null;
  let start = 0;
  for (const line of text.split('\n')) {
    const f = FENCE.exec(line);
    if (f) {
      const marker = f[1];
      if (fence === null) fence = marker[0].repeat(marker.length);
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    } else if (fence === null) {
      const h = HEADING.exec(line);
      if (h) out.push({ start, level: h[1].length, title: (h[2] ?? '').trim() });
    }
    start += line.length + 1;
  }
  return out;
}

/**
 * Target of an "이 섹션" request. A non-empty selection wins as is. Otherwise the heading at or above `pos` and
 * everything up to the next heading of the same or a higher level (or the end); before the first heading, the
 * leading text up to that heading.
 */
export function sectionRange(text: string, pos: number, selection?: TextRange | null): SectionRange {
  if (selection && selection.to > selection.from) {
    return { from: selection.from, to: Math.min(selection.to, text.length), level: 0, title: '' };
  }
  const p = Math.max(0, Math.min(pos, text.length));
  const heads = headingLines(text);
  let idx = -1;
  for (let i = 0; i < heads.length; i++) {
    if (heads[i].start <= p) idx = i;
    else break;
  }
  if (idx === -1) {
    return { from: 0, to: heads[0]?.start ?? text.length, level: 0, title: '' };
  }
  const head = heads[idx];
  let to = text.length;
  for (let i = idx + 1; i < heads.length; i++) {
    if (heads[i].level <= head.level) {
      to = heads[i].start;
      break;
    }
  }
  return { from: head.start, to, level: head.level, title: head.title };
}

/**
 * A streaming answer shown in place: `[from, from + shown)` holds what is on screen for the request — the original
 * text until the first delta arrives, then the streamed text so far.
 */
export interface StreamState {
  from: number;
  /** The text the request replaces ('' for an insertion). */
  original: string;
  streamed: string;
  /** Length of the request's span in the document right now. */
  shown: number;
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export function startStream(range: TextRange, doc: string): StreamState {
  const original = doc.slice(range.from, range.to);
  return { from: range.from, original, streamed: '', shown: original.length };
}

/** The change that shows `delta` and the state after it. The first delta replaces the original text. */
export function streamDelta(state: StreamState, delta: string): { change: TextChange; state: StreamState } {
  const first = state.streamed === '';
  const change: TextChange = first
    ? { from: state.from, to: state.from + state.shown, insert: delta }
    : { from: state.from + state.shown, to: state.from + state.shown, insert: delta };
  const streamed = state.streamed + delta;
  return { change, state: { ...state, streamed, shown: streamed.length } };
}

/**
 * Ending a stream as one undo step: `revert` (kept out of history) puts the original back, then `apply` (one history
 * event) replaces it with `final`. With nothing streamed and no final text, both are null (the document is untouched).
 */
export function commitStream(state: StreamState, final: string | null): { revert: TextChange | null; apply: TextChange | null } {
  const revert =
    state.streamed === '' && state.shown === state.original.length
      ? null
      : { from: state.from, to: state.from + state.shown, insert: state.original };
  if (final === null || final === state.original) return { revert, apply: null };
  return { revert, apply: { from: state.from, to: state.from + state.original.length, insert: final } };
}

/**
 * The cleaned answer fitted into its place: a replaced section keeps the original's trailing blank lines, a full
 * rewrite ends with one newline, an insertion is separated from the text around it by a blank line.
 */
export function fitAnswer(answer: string, mode: NoteAiMode, around: { original: string; before: string; after: string }): string {
  const body = answer.replace(/\s+$/, '');
  if (!body) return '';
  if (mode === 'rewrite') return `${body}\n`;
  if (mode === 'section') {
    const trailing = /\s*$/.exec(around.original)?.[0] ?? '';
    return body + (trailing || (around.after ? '\n' : ''));
  }
  const lead = around.before === '' || around.before.endsWith('\n\n') ? '' : around.before.endsWith('\n') ? '\n' : '\n\n';
  const tail = around.after === '' ? '\n' : around.after.startsWith('\n') ? '\n' : '\n\n';
  return lead + body + tail;
}
