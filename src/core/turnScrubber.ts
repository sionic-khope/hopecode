// Turn scrubber (the conversation minimap on the chat's left edge): one tick per user message. Pure helpers for the
// renderer (turn list, preview text, hover magnification, overflow window) and for main (bookmark validation).
import type { ChatItem } from '../shared/types';

/** One turn as the scrubber lists it: the user message that opens it and the agent text that answered. */
export interface TurnSource {
  /** Id of the user item (scroll target, bookmark key). */
  id: string;
  /** 0-based position in the conversation. */
  index: number;
  /** First non-empty line of the prompt. */
  prompt: string;
  /** Top-level agent text items of the turn, in order (enough of them for a preview). */
  replyTexts: string[];
}

/** A turn with its answer reduced to preview text. */
export interface TurnInfo {
  id: string;
  index: number;
  prompt: string;
  /** Start of the agent's answer as plain text ('' while nothing came back). */
  reply: string;
}

/** Characters of answer text the preview card shows. */
export const REPLY_PREVIEW_CHARS = 120;
/** Characters of the prompt used in a tick's aria-label. */
export const LABEL_PROMPT_CHARS = 40;

/** At most this many bookmarks are kept per thread (oldest dropped first). */
export const MAX_TURN_BOOKMARKS = 500;
/** Item ids are short generated strings; anything longer is not one. */
export const MAX_TURN_ITEM_ID = 128;

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('').trimEnd()}…`;
}

/** First non-empty line, whitespace collapsed. */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

/**
 * Markdown -> one line of plain text for a preview: fenced code blocks are left out, inline marks / links / images /
 * headings / quotes / list markers / table pipes are dropped, whitespace collapses. `max` clips with an ellipsis.
 */
export function plainPreview(markdown: string, max: number = REPLY_PREVIEW_CHARS): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split('\n')) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence !== null) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && raw.trim() === open[1]) fence = null;
      continue;
    }
    if (open) {
      fence = open[1]!;
      continue;
    }
    // Table separator rows (|---|:-:|) and rules carry no text.
    if (raw.includes('-') && /^[\s|:-]+$/.test(raw)) continue;
    let line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(>\s?)+/, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\s*([-*_]\s*){3,}$/, '');
    line = line
      // Backslash escapes are literal text: parked in the private-use range until the marks are gone.
      .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_m, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)))
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_(?!\s)([^_]+?)_(?!\w)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/\s*\|\s*/g, ' ')
      .replace(/[\uE000-\uE07F]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));
    kept.push(line);
  }
  return clip(kept.join(' ').replace(/\s+/g, ' ').trim(), max);
}

/**
 * Turns of a transcript, one per user item, cheap enough to run on every streamed delta: the prompt's first line and
 * the top-level agent text after it (subagent text, tools and notices are left out) up to the next user item.
 * Answer text stops being collected once there is plenty for a preview.
 */
export function collectTurns(items: readonly ChatItem[], replyChars: number = REPLY_PREVIEW_CHARS): TurnSource[] {
  const turns: TurnSource[] = [];
  let collected = 0;
  for (const item of items) {
    if (item.type === 'user') {
      const prompt = firstLine(item.text) || (item.images?.length ? '이미지' : item.files?.length ? '첨부 파일' : '');
      turns.push({ id: item.id, index: turns.length, prompt, replyTexts: [] });
      collected = 0;
      continue;
    }
    const turn = turns[turns.length - 1];
    if (!turn || item.type !== 'assistant-text' || item.parentToolUseId || !item.text) continue;
    if (collected >= replyChars * 8) continue;
    turn.replyTexts.push(item.text);
    collected += item.text.length;
  }
  return turns;
}

/** The answer of `turn` as preview text (code blocks left out, markdown marks dropped, clipped). */
export function turnReplyPreview(turn: Pick<TurnSource, 'replyTexts'>, max: number = REPLY_PREVIEW_CHARS): string {
  return plainPreview(turn.replyTexts.join('\n\n'), max);
}

/** Turns with their preview text (what the preview card shows for each). */
export function extractTurns(items: readonly ChatItem[], replyChars: number = REPLY_PREVIEW_CHARS): TurnInfo[] {
  return collectTurns(items, replyChars).map((t) => ({
    id: t.id,
    index: t.index,
    prompt: t.prompt,
    reply: turnReplyPreview(t, replyChars),
  }));
}

/** aria-label of a tick: "턴 N: 프롬프트 앞부분". */
export function turnLabel(turn: Pick<TurnSource, 'index' | 'prompt'>): string {
  const head = clip(turn.prompt, LABEL_PROMPT_CHARS);
  return head ? `턴 ${turn.index + 1}: ${head}` : `턴 ${turn.index + 1}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Hover magnification (Dock style)
// ---------------------------------------------------------------------------------------------------------------

/** Gaussian falloff of the hover magnification: 1 under the cursor, ~0.6 one sigma away, ~0 beyond three. */
export function magnification(distancePx: number, sigmaPx: number): number {
  if (!(sigmaPx > 0) || !Number.isFinite(distancePx)) return 0;
  return Math.exp(-(distancePx * distancePx) / (2 * sigmaPx * sigmaPx));
}

/**
 * Magnification per visible tick for a cursor at `cursorY` (px from the track top). Ticks are `gap` px apart with
 * their centers at gap/2, 3gap/2, ...; values below `floor` read as 0 so far ticks skip style writes. `null` cursor:
 * all zero.
 */
export function magnifyTicks(count: number, gap: number, cursorY: number | null, sigmaPx: number, floor = 0.02): number[] {
  const out = new Array<number>(count).fill(0);
  if (cursorY === null || count <= 0 || !(gap > 0)) return out;
  for (let i = 0; i < count; i++) {
    const m = magnification(cursorY - (i + 0.5) * gap, sigmaPx);
    out[i] = m < floor ? 0 : m;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Layout: tick spacing and the overflow window
// ---------------------------------------------------------------------------------------------------------------

export interface ScrubberLayout {
  /** Distance between tick centers (px). */
  gap: number;
  /** How many ticks fit (equals `count` unless the scrubber overflows). */
  visible: number;
}

/**
 * Spacing for `count` ticks in `availablePx`: `maxGap` while they fit, shrinking down to `minGap`; past that only
 * the ticks that fit at `minGap` are shown (a window, see `scrubberWindow`).
 */
export function scrubberLayout(count: number, availablePx: number, maxGap: number, minGap: number): ScrubberLayout {
  if (count <= 0) return { gap: maxGap, visible: 0 };
  const room = Math.max(0, availablePx);
  const fit = room / count;
  if (fit >= maxGap) return { gap: maxGap, visible: count };
  if (fit >= minGap) return { gap: fit, visible: count };
  return { gap: minGap, visible: Math.max(1, Math.min(count, Math.floor(room / minGap))) };
}

/** [start, end) of `visible` ticks out of `count`, centered on `center` and clamped to the ends. */
export function scrubberWindow(count: number, visible: number, center: number): { start: number; end: number } {
  const size = Math.max(0, Math.min(count, visible));
  if (size >= count) return { start: 0, end: count };
  const c = Math.min(Math.max(0, Math.round(center)), count - 1);
  const start = Math.min(Math.max(0, c - Math.floor(size / 2)), count - size);
  return { start, end: start + size };
}

// ---------------------------------------------------------------------------------------------------------------
// Bookmarks (persisted per thread as user item ids)
// ---------------------------------------------------------------------------------------------------------------

export function isTurnItemId(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_TURN_ITEM_ID && !/[\0\n\r]/.test(v);
}

/** Saved / received bookmark list -> unique valid ids in order, at most MAX_TURN_BOOKMARKS (newest kept). */
export function sanitizeTurnBookmarks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (!isTurnItemId(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.length > MAX_TURN_BOOKMARKS ? out.slice(out.length - MAX_TURN_BOOKMARKS) : out;
}

/** `list` with `itemId` added (at the end) or removed. */
export function toggleTurnBookmark(list: readonly string[] | undefined, itemId: string, bookmarked: boolean): string[] {
  const rest = (list ?? []).filter((id) => id !== itemId);
  return sanitizeTurnBookmarks(bookmarked ? [...rest, itemId] : rest);
}
