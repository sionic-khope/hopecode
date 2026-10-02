import { describe, expect, it } from 'vitest';
import type { StructuredPatchHunk } from '../../src/shared/types';
import {
  changedWords,
  diffLinesFromHunk,
  diffLinesFromHunks,
  diffLinesFromOldNew,
  diffRowsFromHunks,
  diffRowsFromOldNew,
  foldContext,
  limitEntries,
} from '../../src/renderer/components/Chat/diffLines';

function hunk(partial: Partial<StructuredPatchHunk>): StructuredPatchHunk {
  return { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [], ...partial };
}

describe('diffLinesFromHunk', () => {
  it('assigns running old/new line numbers per marker', () => {
    const h = hunk({
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4,
      lines: [' context one', '-removed line', '+added line', '+another added', ' context two'],
    });
    expect(diffLinesFromHunk(h)).toEqual([
      { kind: 'context', oldLineNo: 10, newLineNo: 10, text: 'context one' },
      { kind: 'del', oldLineNo: 11, newLineNo: null, text: 'removed line' },
      { kind: 'add', oldLineNo: null, newLineNo: 11, text: 'added line' },
      { kind: 'add', oldLineNo: null, newLineNo: 12, text: 'another added' },
      { kind: 'context', oldLineNo: 12, newLineNo: 13, text: 'context two' },
    ]);
  });

  it('handles a pure addition hunk (no context/removed lines)', () => {
    const h = hunk({ oldStart: 5, oldLines: 0, newStart: 5, newLines: 2, lines: ['+first', '+second'] });
    expect(diffLinesFromHunk(h)).toEqual([
      { kind: 'add', oldLineNo: null, newLineNo: 5, text: 'first' },
      { kind: 'add', oldLineNo: null, newLineNo: 6, text: 'second' },
    ]);
  });

  it('handles a pure deletion hunk', () => {
    const h = hunk({ oldStart: 3, oldLines: 2, newStart: 3, newLines: 0, lines: ['-gone', '-also gone'] });
    expect(diffLinesFromHunk(h)).toEqual([
      { kind: 'del', oldLineNo: 3, newLineNo: null, text: 'gone' },
      { kind: 'del', oldLineNo: 4, newLineNo: null, text: 'also gone' },
    ]);
  });

  it('treats a leading backslash as a non-incrementing meta line', () => {
    const h = hunk({
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-old', '\\ No newline at end of file', '+new'],
    });
    expect(diffLinesFromHunk(h)).toEqual([
      { kind: 'del', oldLineNo: 1, newLineNo: null, text: 'old' },
      { kind: 'meta', oldLineNo: null, newLineNo: null, text: '\\ No newline at end of file' },
      { kind: 'add', oldLineNo: null, newLineNo: 1, text: 'new' },
    ]);
  });

  it('handles an empty line entry (blank context line)', () => {
    const h = hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [''] });
    expect(diffLinesFromHunk(h)).toEqual([{ kind: 'context', oldLineNo: 1, newLineNo: 1, text: '' }]);
  });
});

describe('diffLinesFromHunks', () => {
  it('flattens multiple hunks in order, each with independent counters', () => {
    const hunks: StructuredPatchHunk[] = [
      hunk({ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }),
      hunk({ oldStart: 20, newStart: 21, lines: [' c', '+d'] }),
    ];
    expect(diffLinesFromHunks(hunks)).toEqual([
      { kind: 'del', oldLineNo: 1, newLineNo: null, text: 'a' },
      { kind: 'add', oldLineNo: null, newLineNo: 1, text: 'b' },
      { kind: 'context', oldLineNo: 20, newLineNo: 21, text: 'c' },
      { kind: 'add', oldLineNo: null, newLineNo: 22, text: 'd' },
    ]);
  });

  it('returns an empty array for no hunks', () => {
    expect(diffLinesFromHunks([])).toEqual([]);
  });
});

describe('diffLinesFromOldNew', () => {
  it('renders whole old text as deletions then whole new text as additions', () => {
    expect(diffLinesFromOldNew('a\nb', 'a\nb\nc')).toEqual([
      { kind: 'del', oldLineNo: 1, newLineNo: null, text: 'a' },
      { kind: 'del', oldLineNo: 2, newLineNo: null, text: 'b' },
      { kind: 'add', oldLineNo: null, newLineNo: 1, text: 'a' },
      { kind: 'add', oldLineNo: null, newLineNo: 2, text: 'b' },
      { kind: 'add', oldLineNo: null, newLineNo: 3, text: 'c' },
    ]);
  });

  it('handles empty old text (pure insert)', () => {
    expect(diffLinesFromOldNew('', 'x')).toEqual([{ kind: 'add', oldLineNo: null, newLineNo: 1, text: 'x' }]);
  });

  it('handles empty new text (pure delete)', () => {
    expect(diffLinesFromOldNew('x', '')).toEqual([{ kind: 'del', oldLineNo: 1, newLineNo: null, text: 'x' }]);
  });
});

describe('diff display model', () => {
  it('marks the changed word of a paired -/+ line, widened to the whole token', () => {
    expect(changedWords('export const VERSION = 1;', 'export const VERSION = 2;')).toEqual({ old: [23, 24], new: [23, 24] });
    // "count" -> "counter": the whole identifier, not just "er".
    expect(changedWords('let count = 0;', 'let counter = 0;')).toEqual({ old: [4, 9], new: [4, 11] });
    // Nothing shared: no highlight.
    expect(changedWords('alpha', 'omega')).toBeNull();
    expect(changedWords('same', 'same')).toBeNull();
  });

  it('adds a header before every hunk but the first and pairs del/add runs', () => {
    const rows = diffRowsFromHunks([
      hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a = 1;', '+a = 2;'] }),
      hunk({ oldStart: 40, oldLines: 2, newStart: 40, newLines: 2, lines: [' x', '-y'] }),
    ]);
    expect(rows.map((r) => (r.kind === 'hunk' ? r.label : r.line.kind))).toEqual(['del', 'add', '@@ -40,2 +40,2 @@', 'context', 'del']);
    expect(rows[1]).toMatchObject({ kind: 'line', word: [4, 5] });
    expect(rows[4]).toMatchObject({ kind: 'line', word: null });
  });

  it('folds long unchanged runs to three lines on each side, unless opened', () => {
    const lines = [' a', ...Array.from({ length: 12 }, (_, i) => ` c${i}`), '+new'];
    const rows = diffRowsFromHunks([hunk({ lines })]);
    const folded = foldContext(rows);
    expect(folded).toHaveLength(3 + 1 + 3 + 1);
    const fold = folded[3]!;
    expect(fold).toMatchObject({ kind: 'fold', id: 0 });
    expect(fold.kind === 'fold' ? fold.hidden : []).toHaveLength(13 - 6);
    expect(foldContext(rows, new Set([0]))).toHaveLength(rows.length);
    // A short run stays as is.
    expect(foldContext(diffRowsFromHunks([hunk({ lines: [' a', ' b', '+c'] })]))).toHaveLength(3);
  });

  it('limits to N line rows and reports the rest', () => {
    const rows = diffRowsFromOldNew('', Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'));
    const { shown, rest } = limitEntries(rows, 4);
    expect(shown).toHaveLength(4);
    expect(rest).toBe(6);
    expect(limitEntries(rows, null)).toEqual({ shown: rows, rest: 0 });
  });
});
