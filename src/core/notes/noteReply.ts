// 노트 모드 conversation answers (pure, unit-tested). An answer is a chat reply in markdown; only when the user asked
// for the note to be written or changed does it carry fenced blocks with a `note-*` info string, which the page writes
// straight into the editor while they stream (the chat keeps a one-line result for each):
//
//   ```note-insert                      -> at the editor caret
//   ```note-replace section="<heading>" -> the section under that heading
//   ```note-replace-all                 -> the whole note
//
// A block body is markdown and may hold code fences of its own. Those always carry a language (the writing rules ask
// for it), so inside a block a fence line with an info string opens a nested block and a bare fence closes the
// innermost open block: the nested one first, then the block. Streaming answers parse the same way; a block whose
// closing fence has not arrived yet is `complete: false` and fills in as text comes.
import { getLanguage, translate, type Language } from '../../shared/i18n';
import type { NoteCardMark } from '../../shared/notes';

export type NoteCardKind = 'insert' | 'replace' | 'replace-all';

export interface NoteCard {
  kind: NoteCardKind;
  /** replace: the heading text named by `section="…"` (null when the attribute is missing). */
  section: string | null;
  body: string;
  /** The closing fence arrived (or the answer ended without one). */
  complete: boolean;
}

export type NoteReplySegment = { type: 'text'; text: string } | { type: 'card'; index: number; card: NoteCard };

const OPEN = /^ {0,3}(`{3,})[ \t]*note-(insert|replace-all|replace)\b(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SECTION_ATTR = /section\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”)/;

function sectionOf(rest: string): string | null {
  const m = SECTION_ATTR.exec(rest);
  if (!m) return null;
  const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return value || null;
}

/**
 * Splits an answer into text and cards. `streaming`: the answer may continue, so an unclosed card stays incomplete;
 * at the end of an answer an unclosed card is taken as complete (the model forgot the closing fence).
 */
export function parseNoteReply(text: string, streaming = false): NoteReplySegment[] {
  const out: NoteReplySegment[] = [];
  const lines = text.split('\n');
  // While streaming, a last line starting with a backtick may be a fence still being typed (`note-repl…`): hold it.
  if (streaming && /^ {0,3}`/.test(lines[lines.length - 1] ?? '')) lines.pop();
  let prose: string[] = [];
  let index = 0;

  const flushProse = () => {
    const joined = prose.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (joined.trim()) out.push({ type: 'text', text: joined });
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const open = OPEN.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      i++;
      continue;
    }
    flushProse();
    const ticks = open[1].length;
    const kind = (open[2] === 'replace-all' ? 'replace-all' : open[2]) as NoteCardKind;
    const section = kind === 'replace' ? sectionOf(open[3]) : null;
    const body: string[] = [];
    /** Open nested fences inside the card (marker char + length). */
    const nested: string[] = [];
    let closed = false;
    i++;
    for (; i < lines.length; i++) {
      const line = lines[i];
      const f = FENCE.exec(line);
      if (f) {
        const marker = f[1];
        const info = f[2].trim();
        const top = nested[nested.length - 1];
        if (top !== undefined) {
          if (info === '' && marker[0] === top[0] && marker.length >= top.length) nested.pop();
          body.push(line);
          continue;
        }
        if (info === '' && marker[0] === '`' && marker.length >= ticks) {
          closed = true;
          i++;
          break;
        }
        if (info !== '') nested.push(marker);
      }
      body.push(line);
    }
    const bodyText = body.join('\n');
    out.push({
      type: 'card',
      index: index++,
      card: { kind, section, body: bodyText.replace(/^\n+/, '').replace(/\s+$/, ''), complete: closed || !streaming },
    });
  }
  flushProse();
  return out;
}

/** Note blocks of an answer in order (index = position). An answer without any is a plain chat reply. */
export function noteCards(text: string, streaming = false): NoteCard[] {
  return parseNoteReply(text, streaming).flatMap((s) => (s.type === 'card' ? [s.card] : []));
}

/** Card heading: the body's first heading, else "본문 초안" (in `lang`). */
export function cardTitle(card: NoteCard, lang: Language = getLanguage()): string {
  const m = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(card.body);
  return m ? m[1].trim() : translate(lang, 'noteCard.draft');
}

/** Where a card goes, as the card says it. */
export function cardTargetLabel(card: NoteCard, lang: Language = getLanguage()): string {
  if (card.kind === 'insert') return translate(lang, 'noteCard.insert');
  if (card.kind === 'replace-all') return translate(lang, 'noteCard.replaceAll');
  return card.section ? translate(lang, 'noteCard.replaceSection', { section: card.section }) : translate(lang, 'noteCard.replaceSectionNone');
}

/**
 * Plain text of an answer without its note blocks (history in the next prompt, summaries): each block becomes a short
 * marker (the note itself holds the text). Markers stay Korean in any UI language: they go back into the Korean prompt.
 */
export function replyProse(text: string): string {
  return parseNoteReply(text)
    .map((s) => (s.type === 'text' ? s.text : `[note 블록: ${cardTargetLabel(s.card, 'ko')} · ${cardTitle(s.card, 'ko')}]`))
    .join('\n\n');
}

/** Lines of a block body (what the result line and the document chip count). */
export function cardLines(card: Pick<NoteCard, 'body'>): number {
  return card.body === '' ? 0 : card.body.split('\n').length;
}

/**
 * What the result line of a block says. `mark` is what happened to it (absent: an answer saved before blocks were
 * written automatically, or one still streaming).
 */
export type NoteCardStatus = 'writing' | 'applied' | 'reverted' | 'skipped' | 'unapplied';

export function cardStatus(mark: NoteCardMark | undefined, streaming: boolean): NoteCardStatus {
  if (mark) return mark.state;
  if (streaming) return 'writing';
  return 'unapplied';
}
