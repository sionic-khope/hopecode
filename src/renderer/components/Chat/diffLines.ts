// Pure hunk -> render-line transform (plan 4.4 / 9.1 diffLines). No DOM, no React.
import type { StructuredPatchHunk } from '../../../shared/types';

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta';

export interface DiffRenderLine {
  kind: DiffLineKind;
  /** 1-based old-file line number, null for added/meta lines. */
  oldLineNo: number | null;
  /** 1-based new-file line number, null for deleted/meta lines. */
  newLineNo: number | null;
  /** Line content with the leading +/-/space marker stripped. */
  text: string;
}

/**
 * Convert one structuredPatch hunk into renderable +/- lines with running
 * old/new line numbers. A leading `\` (e.g. "\ No newline at end of file")
 * is treated as a non-incrementing meta line.
 */
export function diffLinesFromHunk(hunk: StructuredPatchHunk): DiffRenderLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const out: DiffRenderLine[] = [];

  for (const raw of hunk.lines) {
    const marker = raw.length > 0 ? raw[0] : ' ';
    const text = raw.length > 0 ? raw.slice(1) : '';

    if (marker === '+') {
      out.push({ kind: 'add', oldLineNo: null, newLineNo: newLine, text });
      newLine += 1;
    } else if (marker === '-') {
      out.push({ kind: 'del', oldLineNo: oldLine, newLineNo: null, text });
      oldLine += 1;
    } else if (marker === '\\') {
      out.push({ kind: 'meta', oldLineNo: null, newLineNo: null, text: raw });
    } else {
      // ' ' (context) or any unrecognized marker: treat as context, keep both counters moving.
      out.push({ kind: 'context', oldLineNo: oldLine, newLineNo: newLine, text });
      oldLine += 1;
      newLine += 1;
    }
  }

  return out;
}

/** Flatten every hunk of a structuredPatch into one ordered line list. */
export function diffLinesFromHunks(hunks: readonly StructuredPatchHunk[]): DiffRenderLine[] {
  return hunks.flatMap((hunk) => diffLinesFromHunk(hunk));
}

/**
 * Fallback for tool inputs that carry old/new full text instead of a
 * structuredPatch (e.g. Edit tool_use before its tool_result arrives).
 * Renders the whole old text as deletions followed by the whole new text as
 * additions -- a simple, honest -/+ view, not a real diff algorithm.
 */
export function diffLinesFromOldNew(oldText: string, newText: string): DiffRenderLine[] {
  const oldLines = oldText.length > 0 ? oldText.split('\n') : [];
  const newLines = newText.length > 0 ? newText.split('\n') : [];
  const out: DiffRenderLine[] = [];
  oldLines.forEach((text, i) => out.push({ kind: 'del', oldLineNo: i + 1, newLineNo: null, text }));
  newLines.forEach((text, i) => out.push({ kind: 'add', oldLineNo: null, newLineNo: i + 1, text }));
  return out;
}

// ---------------------------------------------------------------------------
// Display model: hunk headers, changed-word ranges, folded unchanged runs, a row budget.
// ---------------------------------------------------------------------------

/** Changed span of a paired -/+ line, as [start, end) offsets into its text. */
export type WordRange = readonly [number, number];

export type DiffRow =
  | { kind: 'line'; line: DiffRenderLine; word: WordRange | null }
  | { kind: 'hunk'; label: string };

/** `@@ -80,5 +81,5 @@` */
export function hunkLabel(h: StructuredPatchHunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

const WORD_CHAR = /[\p{L}\p{N}_$]/u;

/**
 * The changed middle of two versions of one line: common prefix / suffix stripped, widened to whole words. null when
 * nothing is shared (a rewritten line reads better without a highlight) or the lines are equal.
 */
export function changedWords(oldText: string, newText: string): { old: WordRange; new: WordRange } | null {
  if (oldText === newText) return null;
  const max = Math.min(oldText.length, newText.length);
  let pre = 0;
  while (pre < max && oldText[pre] === newText[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && oldText[oldText.length - 1 - suf] === newText[newText.length - 1 - suf]) suf++;
  // Widen to word boundaries so "VERSION = 1" -> "2" marks the token, not half of it.
  while (pre > 0 && WORD_CHAR.test(oldText[pre - 1]!) && (WORD_CHAR.test(oldText[pre]!) || WORD_CHAR.test(newText[pre]!))) pre--;
  while (
    suf > 0 &&
    WORD_CHAR.test(oldText[oldText.length - suf]!) &&
    (WORD_CHAR.test(oldText[oldText.length - suf - 1] ?? '') || WORD_CHAR.test(newText[newText.length - suf - 1] ?? ''))
  )
    suf--;
  const shared = pre + suf;
  if (shared === 0 || shared < Math.min(oldText.trim().length, newText.trim().length) * 0.3) return null;
  return { old: [pre, oldText.length - suf], new: [pre, newText.length - suf] };
}

function withWords(lines: DiffRenderLine[]): DiffRow[] {
  const rows: DiffRow[] = lines.map((line) => ({ kind: 'line', line, word: null }));
  // A run of deletions followed directly by a run of additions: pair them line by line.
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d]!.kind === 'del') d++;
    let a = d;
    while (a < lines.length && lines[a]!.kind === 'add') a++;
    const pairs = Math.min(d - i, a - d);
    for (let k = 0; k < pairs; k++) {
      const words = changedWords(lines[i + k]!.text, lines[d + k]!.text);
      if (!words) continue;
      rows[i + k] = { kind: 'line', line: lines[i + k]!, word: words.old };
      rows[d + k] = { kind: 'line', line: lines[d + k]!, word: words.new };
    }
    i = a;
  }
  return rows;
}

/** Hunks as display rows: a header before every hunk but the first, changed words marked within each hunk. */
export function diffRowsFromHunks(hunks: readonly StructuredPatchHunk[]): DiffRow[] {
  return hunks.flatMap((h, i) => {
    const rows = withWords(diffLinesFromHunk(h));
    return i === 0 ? rows : [{ kind: 'hunk', label: hunkLabel(h) } as DiffRow, ...rows];
  });
}

export function diffRowsFromOldNew(oldText: string, newText: string): DiffRow[] {
  return withWords(diffLinesFromOldNew(oldText, newText));
}

/** Unchanged lines kept on each side of a folded run. */
export const FOLD_EDGE = 3;
/** Runs longer than this fold (shorter ones would hide too little to be worth a click). */
export const FOLD_MIN = 2 * FOLD_EDGE + 2;

export type DiffEntry =
  | DiffRow
  /** `id`: index of the run's first row (stable across renders), `hidden`: the rows behind it. */
  | { kind: 'fold'; id: number; hidden: DiffRow[] };

/** Long runs of context lines fold to FOLD_EDGE lines on each side, except the runs whose id is in `open`. */
export function foldContext(rows: readonly DiffRow[], open: ReadonlySet<number> = new Set()): DiffEntry[] {
  const out: DiffEntry[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.kind !== 'line' || row.line.kind !== 'context') {
      out.push(row);
      i++;
      continue;
    }
    let end = i;
    while (end < rows.length) {
      const r = rows[end]!;
      if (r.kind !== 'line' || r.line.kind !== 'context') break;
      end++;
    }
    const run = rows.slice(i, end);
    if (run.length > FOLD_MIN && !open.has(i)) {
      out.push(...run.slice(0, FOLD_EDGE));
      out.push({ kind: 'fold', id: i, hidden: run.slice(FOLD_EDGE, run.length - FOLD_EDGE) });
      out.push(...run.slice(run.length - FOLD_EDGE));
    } else {
      out.push(...run);
    }
    i = end;
  }
  return out;
}

/**
 * The first `limit` line rows (headers and folds in between ride along) and how many line rows are left after them.
 * `limit` null shows everything.
 */
export function limitEntries(entries: readonly DiffEntry[], limit: number | null): { shown: DiffEntry[]; rest: number } {
  if (limit === null) return { shown: [...entries], rest: 0 };
  const shown: DiffEntry[] = [];
  let lines = 0;
  let rest = 0;
  for (const e of entries) {
    if (e.kind !== 'line') {
      if (lines < limit) shown.push(e);
      continue;
    }
    if (lines < limit) shown.push(e);
    else rest++;
    lines++;
  }
  return { shown, rest };
}
