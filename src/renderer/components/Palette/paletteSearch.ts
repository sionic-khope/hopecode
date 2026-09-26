/**
 * Pure ranking for the command palette. Every query word must match somewhere (AND); each word is scored by the
 * best tier it reaches, and the item's score is the sum. Tiers, best first:
 *   exact title (whole query) > title prefix > word-start in title > substring in title
 *   > substring in keywords/subtitle > in-order subsequence of title chars (fuzzy, gaps penalized).
 * Korean titles also answer 초성 queries ("ㅅㅈ" finds "설정"): the title is projected onto its initial consonants
 * one char per syllable, so match positions map straight back onto the title for highlighting.
 */

export interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  keywords?: readonly string[];
}

export interface PaletteMatch<T extends PaletteItem> {
  item: T;
  score: number;
  /** Half-open [start, end) highlight ranges in `item.title`, sorted and non-overlapping. */
  ranges: [number, number][];
}

const SCORE_EXACT = 1000;
const TIER_PREFIX = 500;
const TIER_WORD_START = 400;
const TIER_SUBSTRING = 300;
const TIER_META = 200;
const TIER_FUZZY = 100;

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
const SYLLABLES_PER_INITIAL = 588; // 21 medials * 28 finals
const CHOSEONG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'] as const;
const WORD_SEPARATOR = /[\s\-_./]/;

/** Replaces each precomposed Hangul syllable with its initial consonant (compatibility jamo); other chars stay. */
export function toChoseong(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch.length === 1 && code >= HANGUL_START && code <= HANGUL_END) {
      out += CHOSEONG[Math.floor((code - HANGUL_START) / SYLLABLES_PER_INITIAL)];
    } else {
      out += ch;
    }
  }
  return out;
}

/** True when every char is a compatibility-jamo consonant (ㄱ U+3131 .. ㅎ U+314E). */
function isChoseongQuery(word: string): boolean {
  if (word.length === 0) return false;
  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i);
    if (code < 0x3131 || code > 0x314e) return false;
  }
  return true;
}

interface WordHit {
  score: number;
  ranges: [number, number][];
}

function wordStartIndex(hay: string, word: string): number {
  let from = 0;
  for (;;) {
    const i = hay.indexOf(word, from);
    if (i < 0) return -1;
    if (i === 0 || WORD_SEPARATOR.test(hay[i - 1]!)) return i;
    from = i + 1;
  }
}

/** Tightest in-order subsequence of `word` in `hay` (fewest skipped chars), as contiguous highlight runs. */
function fuzzy(hay: string, word: string): WordHit | null {
  let best: { gaps: number; positions: number[] } | null = null;
  for (let start = hay.indexOf(word[0]!); start >= 0; start = hay.indexOf(word[0]!, start + 1)) {
    const positions = [start];
    let at = start;
    for (let k = 1; k < word.length; k++) {
      at = hay.indexOf(word[k]!, at + 1);
      if (at < 0) break;
      positions.push(at);
    }
    if (positions.length < word.length) break; // later starts cannot succeed either
    const gaps = positions[positions.length - 1]! - start + 1 - word.length;
    if (!best || gaps < best.gaps) best = { gaps, positions };
    if (gaps === 0) break;
  }
  if (!best) return null;
  const ranges: [number, number][] = [];
  for (const p of best.positions) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === p) last[1] = p + 1;
    else ranges.push([p, p + 1]);
  }
  // Fewer gaps and an earlier start rank higher; stays inside (0, TIER_FUZZY).
  const score = TIER_FUZZY * (word.length / (word.length + best.gaps)) - Math.min(best.positions[0]!, 20) * 0.5;
  return { score: Math.max(score, 1), ranges };
}

function titleHit(hay: string, word: string): WordHit | null {
  if (hay.startsWith(word)) return { score: TIER_PREFIX, ranges: [[0, word.length]] };
  const ws = wordStartIndex(hay, word);
  if (ws >= 0) return { score: TIER_WORD_START, ranges: [[ws, ws + word.length]] };
  const sub = hay.indexOf(word);
  if (sub >= 0) return { score: TIER_SUBSTRING, ranges: [[sub, sub + word.length]] };
  return null;
}

interface Prepared {
  title: string;
  choseong: string | null;
  meta: string[];
}

function prepare(item: PaletteItem): Prepared {
  const title = item.title.toLocaleLowerCase();
  const cho = toChoseong(title);
  const meta: string[] = [];
  if (item.subtitle) meta.push(item.subtitle.toLocaleLowerCase());
  for (const k of item.keywords ?? []) meta.push(k.toLocaleLowerCase());
  return { title, choseong: cho === title ? null : cho, meta };
}

function matchWord(p: Prepared, word: string): WordHit | null {
  const hays = [p.title];
  if (p.choseong && isChoseongQuery(word)) hays.push(p.choseong);

  let best: WordHit | null = null;
  for (const hay of hays) {
    const hit = titleHit(hay, word);
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  if (best) return best;

  if (p.meta.some((m) => m.includes(word))) return { score: TIER_META, ranges: [] };

  for (const hay of hays) {
    const hit = fuzzy(hay, word);
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  return best;
}

function mergeRanges(ranges: [number, number][], max: number): [number, number][] {
  const sorted = ranges
    .map(([a, b]): [number, number] => [Math.min(a, max), Math.min(b, max)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export function searchPalette<T extends PaletteItem>(items: readonly T[], query: string, limit?: number): PaletteMatch<T>[] {
  const max = limit === undefined ? Infinity : Math.max(0, limit);
  const q = query.trim().toLocaleLowerCase();
  if (q.length === 0) {
    return items.slice(0, max).map((item) => ({ item, score: 0, ranges: [] }));
  }

  const words = q.split(/\s+/).filter(Boolean);
  const scored: { match: PaletteMatch<T>; index: number }[] = [];

  items.forEach((item, index) => {
    const p = prepare(item);
    if (p.title === q) {
      scored.push({ match: { item, score: SCORE_EXACT * words.length, ranges: [[0, item.title.length]] }, index });
      return;
    }
    let score = 0;
    const ranges: [number, number][] = [];
    for (const word of words) {
      const hit = matchWord(p, word);
      if (!hit) return;
      score += hit.score;
      ranges.push(...hit.ranges);
    }
    scored.push({ match: { item, score, ranges: mergeRanges(ranges, item.title.length) }, index });
  });

  scored.sort((a, b) => b.match.score - a.match.score || a.index - b.index);
  return scored.slice(0, max).map((s) => s.match);
}
