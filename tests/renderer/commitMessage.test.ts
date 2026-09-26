import { describe, expect, it } from 'vitest';
import type { GitChangedFile } from '../../src/shared/types';
import { autoCommitMessage, summarizeCounts } from '../../src/renderer/components/Changes/commitMessage';

function file(partial: Partial<GitChangedFile> & Pick<GitChangedFile, 'path'>): GitChangedFile {
  return { status: 'M', untracked: false, additions: 0, deletions: 0, binary: false, ...partial };
}

function subject(message: string): string {
  return message.split('\n')[0]!;
}

describe('summarizeCounts', () => {
  it('sums additions and deletions', () => {
    expect(
      summarizeCounts([file({ path: 'a.ts', additions: 3, deletions: 1 }), file({ path: 'b.ts', additions: 2, deletions: 5 })]),
    ).toEqual({ files: 2, additions: 5, deletions: 6 });
  });

  it('is all zeros for an empty list', () => {
    expect(summarizeCounts([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});

describe('autoCommitMessage', () => {
  it('returns an empty string for no files', () => {
    expect(autoCommitMessage([])).toBe('');
  });

  it('names a single modified, added and deleted file', () => {
    expect(subject(autoCommitMessage([file({ path: 'README.md', additions: 3, deletions: 1 })]))).toBe('README.md 수정');
    expect(subject(autoCommitMessage([file({ path: 'src/a.ts', status: 'A', untracked: true, additions: 10 })]))).toBe(
      'src/a.ts 추가',
    );
    expect(subject(autoCommitMessage([file({ path: 'old.ts', status: 'D', deletions: 4 })]))).toBe('old.ts 삭제');
  });

  it('describes a rename with both paths', () => {
    const msg = autoCommitMessage([file({ path: 'b.ts', oldPath: 'a.ts', status: 'R' })]);
    expect(subject(msg)).toBe('a.ts → b.ts 이름 변경');
    expect(msg.split('\n')[2]).toBe('- R a.ts → b.ts (+0 −0)');
  });

  it('builds subject + blank line + bullet body', () => {
    expect(autoCommitMessage([file({ path: 'README.md', additions: 3, deletions: 1 })])).toBe(
      'README.md 수정\n\n- M README.md (+3 −1)',
    );
  });

  it('scopes same-kind changes in one top-level directory', () => {
    const msg = autoCommitMessage([file({ path: 'src/a.ts' }), file({ path: 'src/b/c.ts' }), file({ path: 'src/d.ts' })]);
    expect(subject(msg)).toBe('src/ 파일 3개 수정');
  });

  it('lists per-kind counts for mixed changes across directories', () => {
    const msg = autoCommitMessage([
      file({ path: 'src/new.ts', status: 'A' }),
      file({ path: 'src/a.ts' }),
      file({ path: 'lib/b.ts' }),
      file({ path: 'c.ts' }),
      file({ path: 'docs/old.md', status: 'D' }),
    ]);
    expect(subject(msg)).toBe('파일 5개 변경 (추가 1, 수정 3, 삭제 1)');
  });

  it('keeps the directory scope for mixed kinds in one directory', () => {
    const msg = autoCommitMessage([file({ path: 'src/a.ts', status: 'A' }), file({ path: 'src/b.ts' })]);
    expect(subject(msg)).toBe('src/ 파일 2개 변경 (추가 1, 수정 1)');
  });

  it('does not scope root-level files', () => {
    expect(subject(autoCommitMessage([file({ path: 'a.ts' }), file({ path: 'b.ts' })]))).toBe('파일 2개 수정');
  });

  it('keeps the subject at most 72 characters', () => {
    const deep = `${'very-long-directory-name/'.repeat(4)}component-with-a-long-name.tsx`;
    const s = subject(autoCommitMessage([file({ path: deep })]));
    expect(s.length).toBeLessThanOrEqual(72);
    expect(s).toBe('component-with-a-long-name.tsx 수정');

    const huge = `${'x'.repeat(100)}.ts`;
    const s2 = subject(autoCommitMessage([file({ path: huge })]));
    expect(s2.length).toBe(72);
    expect(s2.endsWith('…')).toBe(true);
  });

  it('caps the body at 10 files and summarizes the rest', () => {
    const files = Array.from({ length: 13 }, (_, i) => file({ path: `src/f${i}.ts`, additions: i, deletions: 1 }));
    const lines = autoCommitMessage(files).split('\n');
    expect(lines[0]).toBe('src/ 파일 13개 수정');
    expect(lines[1]).toBe('');
    expect(lines.slice(2)).toHaveLength(11);
    expect(lines[2]).toBe('- M src/f0.ts (+0 −1)');
    expect(lines[11]).toBe('- M src/f9.ts (+9 −1)');
    expect(lines[12]).toBe('- …외 3개');
  });

  it('marks binary files in the body', () => {
    expect(autoCommitMessage([file({ path: 'logo.png', status: 'A', binary: true })]).split('\n')[2]).toBe(
      '- A logo.png (바이너리)',
    );
  });
});
