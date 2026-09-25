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
