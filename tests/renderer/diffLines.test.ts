import { describe, expect, it } from 'vitest';
import type { StructuredPatchHunk } from '../../src/shared/types';
import { diffLinesFromHunk, diffLinesFromHunks, diffLinesFromOldNew } from '../../src/renderer/components/Chat/diffLines';

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
