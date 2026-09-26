import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../src/main/git/unifiedDiff';

describe('parseUnifiedDiff', () => {
  it('parses a modified file with multiple hunks and keeps line markers', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '@@ -10 +10,2 @@ function x() {',
      ' ten',
      '+eleven',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(text);
    expect(file.path).toBe('src/a.ts');
    expect(file.oldPath).toBeUndefined();
    expect(file.binary).toBe(false);
    expect(file.hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-two', '+TWO', ' three'] },
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [' ten', '+eleven'] },
    ]);
  });

  it('handles new and deleted files, no-newline markers and content that looks like headers', () => {
    const text = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+--- a/fake',
      '+last',
      '\\ No newline at end of file',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => f.path)).toEqual(['new.txt', 'gone.txt']);
    expect(files[0].hunks[0]).toEqual({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      lines: ['+--- a/fake', '+last', '\\ No newline at end of file'],
    });
    expect(files[1].hunks[0].lines).toEqual(['-bye']);
  });

  it('parses renames (with and without content changes) and binary files', () => {
    const text = [
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 100%',
      'rename from old name.txt',
      'rename to new name.txt',
      'diff --git a/lib/x.ts b/lib/y.ts',
      'similarity index 80%',
      'rename from lib/x.ts',
      'rename to lib/y.ts',
      '--- a/lib/x.ts',
      '+++ b/lib/y.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/img.png b/img.png',
      'index 5555555..6666666 100644',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files[0]).toEqual({ path: 'new name.txt', oldPath: 'old name.txt', binary: false, hunks: [] });
    expect(files[1].path).toBe('lib/y.ts');
    expect(files[1].oldPath).toBe('lib/x.ts');
    expect(files[1].hunks[0].lines).toEqual(['-a', '+b']);
    expect(files[2]).toEqual({ path: 'img.png', binary: true, hunks: [] });
  });

  it('decodes quoted paths and returns [] for empty input', () => {
    const text = [
      'diff --git "a/t\\303\\251st\\t.txt" "b/t\\303\\251st\\t.txt"',
      '--- "a/t\\303\\251st\\t.txt"',
      '+++ "b/t\\303\\251st\\t.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseUnifiedDiff(text)[0].path).toBe('tést\t.txt');
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
