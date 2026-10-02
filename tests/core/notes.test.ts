import { describe, expect, it } from 'vitest';
import { commitStream, fitAnswer, headingLines, sectionRange, startStream, streamDelta } from '../../src/core/notes/noteEdit';
import { isHiddenNoteName, noteNameError, normalizeNotePath, withMarkdownExt } from '../../src/core/notes/notePaths';
import {
  BANNED_PHRASES,
  NOTE_PROMPT_HEAD,
  STYLE_REF_MAX_FILES,
  STYLE_REF_MAX_LINES,
  buildNoteChatPrompt,
  buildNoteSystemPrompt,
  cleanNoteOutput,
  clipDocument,
  styleRefExcerpt,
} from '../../src/core/notes/notePrompt';
import { noteFixtureAnswer, parseNotePrompt } from '../../src/main/fixtures/noteFixture';

describe('notePaths', () => {
  it('accepts vault-relative paths and refuses escapes, absolute and hidden segments', () => {
    expect(normalizeNotePath('Back-End/distlock.md')).toBe('Back-End/distlock.md');
    expect(normalizeNotePath('', { allowRoot: true })).toBe('');
    for (const bad of ['', '/etc/passwd', '../x.md', 'a/../../x.md', 'a/./b.md', 'a//b.md', '.git/config', 'node_modules/x.md', 'public/a.md', 'a\\b.md', 'a\u0000b.md', 'x'.repeat(2000), 42]) {
      expect(normalizeNotePath(bad)).toBeNull();
    }
  });

  it('checks typed names and appends .md', () => {
    expect(noteNameError('redis-lock')).toBeNull();
    expect(noteNameError('a/b')).not.toBeNull();
    expect(noteNameError('..')).not.toBeNull();
    expect(noteNameError(' x')).not.toBeNull();
    expect(noteNameError('.hidden')).not.toBeNull();
    expect(withMarkdownExt('note')).toBe('note.md');
    expect(withMarkdownExt('note.MD')).toBe('note.MD');
    expect(isHiddenNoteName('.obsidian')).toBe(true);
    expect(isHiddenNoteName('Back-End')).toBe(false);
  });
});

const DOC = ['intro line', '# Title', 'body', '```md', '# not a heading', '```', '## Sub', 'sub body', '# Next', 'tail'].join('\n');

describe('sectionRange', () => {
  it('ignores headings inside fenced code', () => {
    expect(headingLines(DOC).map((h) => h.title)).toEqual(['Title', 'Sub', 'Next']);
  });

  it('spans a heading to the next heading of the same or a higher level', () => {
    const pos = DOC.indexOf('body');
    const r = sectionRange(DOC, pos);
    expect(DOC.slice(r.from, r.to)).toBe('# Title\nbody\n```md\n# not a heading\n```\n## Sub\nsub body\n');
    expect(r.level).toBe(1);
    const sub = sectionRange(DOC, DOC.indexOf('sub body'));
    expect(DOC.slice(sub.from, sub.to)).toBe('## Sub\nsub body\n');
    const last = sectionRange(DOC, DOC.length);
    expect(DOC.slice(last.from, last.to)).toBe('# Next\ntail');
  });

  it('takes the text before the first heading, and a selection wins', () => {
    const lead = sectionRange(DOC, 2);
    expect(DOC.slice(lead.from, lead.to)).toBe('intro line\n');
    expect(sectionRange(DOC, 30, { from: 3, to: 7 })).toEqual({ from: 3, to: 7, level: 0, title: '' });
    expect(sectionRange('no headings', 4)).toMatchObject({ from: 0, to: 11 });
  });
});

describe('stream edits', () => {
  /** Applies a change to a string the way the editor does. */
  const apply = (doc: string, c: { from: number; to: number; insert: string }) => doc.slice(0, c.from) + c.insert + doc.slice(c.to);

  it('replaces the target on the first delta, then appends, and commits as one change', () => {
    let doc = 'A\nOLD\nB';
    let state = startStream({ from: 2, to: 5 }, doc);
    for (const piece of ['ne', 'w ', 'text']) {
      const step = streamDelta(state, piece);
      doc = apply(doc, step.change);
      state = step.state;
    }
    expect(doc).toBe('A\nnew text\nB');
    const { revert, apply: final } = commitStream(state, 'NEW');
    doc = apply(doc, revert!);
    expect(doc).toBe('A\nOLD\nB');
    doc = apply(doc, final!);
    expect(doc).toBe('A\nNEW\nB');
  });

  it('a stop before any text leaves the document untouched', () => {
    const state = startStream({ from: 0, to: 3 }, 'abc');
    expect(commitStream(state, null)).toEqual({ revert: null, apply: null });
  });

  it('fits answers into their place', () => {
    expect(fitAnswer('# T\nbody\n\n', 'all', { original: 'x', before: '', after: '' })).toBe('# T\nbody\n');
    expect(fitAnswer('## S\nnew', 'section', { original: '## S\nold\n\n', before: '', after: '# N' })).toBe('## S\nnew\n\n');
    expect(fitAnswer('text', 'insert', { original: '', before: 'a\n', after: '' })).toBe('\ntext\n');
    expect(fitAnswer('text', 'insert', { original: '', before: 'a', after: 'b' })).toBe('\n\ntext\n\n');
    expect(fitAnswer('   ', 'insert', { original: '', before: '', after: '' })).toBe('');
  });
});

describe('notePrompt', () => {
  it('system prompt carries the study-note format, the polite register and every banned phrase', () => {
    const sys = buildNoteSystemPrompt();
    expect(sys.startsWith(NOTE_PROMPT_HEAD)).toBe(true);
    for (const phrase of BANNED_PHRASES) expect(sys).toContain(phrase);
    expect(sys).toContain('### 1. 소제목');
    expect(sys).toContain('개요');
    expect(sys).toContain('트레이드오프');
    expect(sys).toContain('"~합니다"');
    expect(sys).toContain('이모지');
    expect(sys).toContain('코드펜스');
    expect(sys).toContain('영어 원어');
  });

  it('notes and conversation replies are written in 존댓말 (~합니다/~입니다), not the plain ~다 register', () => {
    const sys = buildNoteSystemPrompt();
    expect(sys).toContain('한국어 존댓말 "~합니다", "~입니다"로 쓴다');
    expect(sys).toContain('평서체("~다", "~이다")와 해요체("~해요")는 쓰지 않는다');
    expect(sys).toContain('대화 문장도 존댓말("~합니다", "~입니다")로');
    expect(sys).not.toContain('한국어 평서체 "~다"');
    expect(sys).toContain('담백한 실무 문어체');
    const chat = buildNoteChatPrompt({ request: 'r', notePath: 'a.md', document: '', history: [], styleRefs: [] });
    expect(chat).toContain('존댓말("~합니다", "~입니다")로 짧고 담백하게');
  });

  it('style refs keep the first lines; long documents keep both ends', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    expect(styleRefExcerpt(long).split('\n')).toHaveLength(STYLE_REF_MAX_LINES);
    const clipped = clipDocument('a'.repeat(100) + 'b'.repeat(100), 50);
    expect(clipped.startsWith('a'.repeat(25))).toBe(true);
    expect(clipped.endsWith('b'.repeat(25))).toBe(true);
  });

  it('unwraps a whole-output markdown fence only', () => {
    expect(cleanNoteOutput('```markdown\n# T\nx\n```\n')).toBe('# T\nx');
    expect(cleanNoteOutput('\n\n# T\n\n```java\nint a;\n```\n')).toBe('# T\n\n```java\nint a;\n```');
  });

  it('the fixture answers follow the kind of the prompt', () => {
    const prompt = buildNoteChatPrompt({ request: '2번 섹션 더 자세히', notePath: 'x.md', document: '# T\n\n### 1. 개념\na\n\n### 2. 정리\nb\n', history: [], styleRefs: [] });
    expect(parseNotePrompt(prompt)).toEqual({ kind: 'chat', request: '2번 섹션 더 자세히', headings: ['T', '1. 개념', '2. 정리'] });
    expect(noteFixtureAnswer(prompt)).toContain('```note-replace section="2. 정리"\n### 2. 정리\n\nFIXTURE-SECTION: 2번 섹션 더 자세히');
  });
});

import { sanitizeSettings, validateSettingsPatch } from '../../src/core/settings';

describe('note vault settings', () => {
  it('are sanitized on load and never accepted from settings:update', () => {
    const s = sanitizeSettings({ noteVaults: ['/a', 'rel', '/a', '/b\u0000', 3, '/c'], activeNoteVault: '/zzz' });
    expect(s.noteVaults).toEqual(['/a', '/c']);
    expect(s.activeNoteVault).toBe('/a');
    expect(sanitizeSettings({ noteVaults: ['/a', '/c'], activeNoteVault: '/c' }).activeNoteVault).toBe('/c');
    expect(validateSettingsPatch({ noteVaults: ['/x'] }).ok).toBe(false);
    expect(validateSettingsPatch({ activeNoteVault: '/x' }).ok).toBe(false);
  });

  it('git opt-ins are a subset of the registered vaults and never accepted from settings:update', () => {
    const s = sanitizeSettings({ noteVaults: ['/a', '/c'], noteGitVaults: ['/c', '/zzz', 'rel', '/c'] });
    expect(s.noteGitVaults).toEqual(['/c']);
    expect(sanitizeSettings({}).noteGitVaults).toEqual([]);
    expect(validateSettingsPatch({ noteGitVaults: ['/a'] }).ok).toBe(false);
  });
});
