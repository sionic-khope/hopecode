// 노트 모드 editor math, independent of CodeMirror (pure, unit-tested): heading sections, the changes that stream an
// answer into a range, how an answer is fitted into the document, and how a conversation's note block is put into the
// note (and found or taken back out afterwards).
import type { NoteCard } from './noteReply';
import { t } from '../../shared/i18n';

/** Where fitted text goes: at the caret, over a heading section, over the whole note. */
export type FitMode = 'insert' | 'section' | 'all';

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
 * The heading section around `pos`. A non-empty selection wins as is. Otherwise the heading at or above `pos` and
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
export function fitAnswer(answer: string, mode: FitMode, around: { original: string; before: string; after: string }): string {
  const body = answer.replace(/\s+$/, '');
  if (!body) return '';
  if (mode === 'all') return `${body}\n`;
  if (mode === 'section') {
    const trailing = /\s*$/.exec(around.original)?.[0] ?? '';
    return body + (trailing || (around.after ? '\n' : ''));
  }
  const lead = around.before === '' || around.before.endsWith('\n\n') ? '' : around.before.endsWith('\n') ? '\n' : '\n\n';
  const tail = around.after === '' ? '\n' : around.after.startsWith('\n') ? '\n' : '\n\n';
  return lead + body + tail;
}

/**
 * An inline answer over a selection: the selection's own leading and trailing whitespace stay as they were, so a
 * phrase replaced inside a paragraph does not gain or lose a line break.
 */
export function fitSelection(answer: string, original: string): string {
  const body = answer.trim();
  if (!body) return '';
  const lead = /^\s*/.exec(original)?.[0] ?? '';
  const trail = /\s*$/.exec(original)?.[0] ?? '';
  return lead + body + trail;
}

/** Heading text as compared for a card's `section="…"`: marks, emphasis and spacing dropped, lowercase. */
export function normalizeHeading(title: string): string {
  return title
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `2. 구조` / `2) 구조` / `2 구조` -> `구조`. */
function withoutNumber(title: string): string {
  return title.replace(/^\d+(?:\.\d+)*[.)]?\s+/, '');
}

export type SectionMatch = { ok: true; range: SectionRange } | { ok: false; error: string };

/**
 * The section a card names: the heading whose text equals `title` (normalized), else the one equal once leading
 * numbers are dropped on both sides. Several equal headings, or none, is an error (the card is not applied).
 */
export function findSection(doc: string, title: string): SectionMatch {
  const want = normalizeHeading(title);
  if (!want) return { ok: false, error: t('noteEdit.noSection') };
  const heads = headingLines(doc);
  const pick = (pred: (t: string) => boolean): SectionMatch | null => {
    const hits = heads.filter((h) => pred(normalizeHeading(h.title)));
    if (hits.length === 1) return { ok: true, range: sectionRange(doc, hits[0].start) };
    if (hits.length > 1) return { ok: false, error: t('noteEdit.ambiguous', { title, count: hits.length }) };
    return null;
  };
  return (
    pick((t) => t === want) ??
    pick((t) => withoutNumber(t) === withoutNumber(want) && withoutNumber(want) !== '') ?? {
      ok: false,
      error: t('noteEdit.notFound', { title }),
    }
  );
}

export interface CardPlan {
  change: TextChange;
  /** What the change replaces (for "되돌리기"). */
  original: string;
}

export type CardTarget = { ok: true; range: TextRange; mode: FitMode } | { ok: false; error: string };

/**
 * Where a note block goes in `doc`, known from its opening line alone (so it can stream in place): the caret for an
 * insertion (an empty note takes it as its whole text), the named section, or everything. A section that cannot be
 * found (or is ambiguous) is an error: nothing is written.
 */
export function cardTarget(doc: string, card: Pick<NoteCard, 'kind' | 'section'>, caret: number): CardTarget {
  if (card.kind === 'replace-all' || doc.trim() === '') return { ok: true, range: { from: 0, to: doc.length }, mode: 'all' };
  if (card.kind === 'replace') {
    const match = findSection(doc, card.section ?? '');
    if (!match.ok) return match;
    return { ok: true, range: { from: match.range.from, to: match.range.to }, mode: 'section' };
  }
  const at = Math.max(0, Math.min(caret, doc.length));
  return { ok: true, range: { from: at, to: at }, mode: 'insert' };
}

/**
 * The change that puts a block into `doc` (see cardTarget), with its body fitted to the place. A block with no body,
 * or a section that cannot be found, is an error.
 */
export function planCard(doc: string, card: Pick<NoteCard, 'kind' | 'section' | 'body'>, caret: number): { ok: true; plan: CardPlan } | { ok: false; error: string } {
  const body = card.body.replace(/\s+$/, '');
  if (!body.trim()) return { ok: false, error: t('noteEdit.emptyCard') };
  const target = cardTarget(doc, card, caret);
  if (!target.ok) return target;
  const { range, mode } = target;
  const original = doc.slice(range.from, range.to);
  const insert = fitAnswer(body, mode, { original, before: doc.slice(0, range.from), after: doc.slice(range.to) });
  return { ok: true, plan: { change: { from: range.from, to: range.to, insert }, original } };
}

/**
 * The change that makes a streamed span show `full` (the block body so far) and the state after it. Text that only
 * grows is appended; anything else (the parser re-read a held line differently) rewrites the span. An empty `full`
 * puts the original back.
 */
export function streamTo(state: StreamState, full: string): { change: TextChange | null; state: StreamState } {
  if (full === state.streamed) return { change: null, state };
  if (state.streamed !== '' && full.startsWith(state.streamed)) return streamDelta(state, full.slice(state.streamed.length));
  if (state.streamed === '') return streamDelta(state, full);
  const shown = full === '' ? state.original : full;
  return {
    change: { from: state.from, to: state.from + state.shown, insert: shown },
    state: { ...state, streamed: full, shown: shown.length },
  };
}

/**
 * Where applied text sits now: at the offset it landed when it is still there, else its only occurrence in the note.
 * null when it was edited since (or appears several times).
 */
export function locateApplied(doc: string, applied: { at: number; inserted: string }): TextRange | null {
  const { at, inserted } = applied;
  if (inserted === '') return null;
  let from = -1;
  if (doc.slice(at, at + inserted.length) === inserted) from = at;
  else {
    const first = doc.indexOf(inserted);
    if (first !== -1 && doc.indexOf(inserted, first + 1) === -1) from = first;
  }
  return from === -1 ? null : { from, to: from + inserted.length };
}

/**
 * Takes applied text back out: it is put back to what it replaced (see locateApplied). null when the text was edited
 * since (⌘Z still can).
 */
export function revertCard(doc: string, applied: { at: number; inserted: string; original: string }): TextChange | null {
  const range = locateApplied(doc, applied);
  return range ? { ...range, insert: applied.original } : null;
}
