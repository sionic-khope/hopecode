import { describe, expect, it } from 'vitest';
import {
  MAX_TURN_BOOKMARKS,
  collectTurns,
  extractTurns,
  firstLine,
  isTurnItemId,
  magnification,
  magnifyTicks,
  plainPreview,
  sanitizeTurnBookmarks,
  scrubberLayout,
  scrubberWindow,
  toggleTurnBookmark,
  turnLabel,
} from '../../src/core/turnScrubber';
import type { ChatItem } from '../../src/shared/types';

let seq = 0;
const user = (text: string, extra: Partial<Extract<ChatItem, { type: 'user' }>> = {}): ChatItem => ({
  type: 'user',
  id: `user-${++seq}`,
  text,
  createdAt: seq,
  ...extra,
});
const say = (text: string, parentToolUseId?: string): ChatItem => ({
  type: 'assistant-text',
  id: `text-${++seq}`,
  text,
  createdAt: seq,
  ...(parentToolUseId ? { parentToolUseId } : {}),
});
const tool = (): ChatItem => ({ type: 'tool', id: `tool-${++seq}`, toolUseId: `tu-${seq}`, name: 'Bash', input: {}, result: 'ok', createdAt: seq });

describe('extractTurns', () => {
  it('opens one turn per user item and keeps only top-level agent text as the reply', () => {
    const items: ChatItem[] = [
      say('stray text before any prompt'),
      user('\n\n  첫 질문   입니다\n둘째 줄'),
      say('첫 답변'),
      tool(),
      say('subagent chatter', 'tu-x'),
      say('이어서 계속'),
      { type: 'notice', id: 'n1', level: 'info', text: 'notice', createdAt: 99 } as ChatItem,
      user('두 번째'),
    ];
    const turns = extractTurns(items);
    expect(turns.map((t) => [t.index, t.prompt, t.reply])).toEqual([
      [0, '첫 질문 입니다', '첫 답변 이어서 계속'],
      [1, '두 번째', ''],
    ]);
    expect(turns[0]!.id).toBe(items[1]!.id);
  });

  it('labels an image-only / file-only prompt', () => {
    const turns = collectTurns([
      user('', { images: [{ mediaType: 'image/png', data: 'AA==' }] }),
      user('  ', { files: [{ name: 'a.pdf', kind: 'pdf', size: 1 }] } as never),
    ]);
    expect(turns.map((t) => t.prompt)).toEqual(['이미지', '첨부 파일']);
  });

  it('stops collecting reply text once there is plenty for a preview', () => {
    const long = 'x'.repeat(400);
    const turns = collectTurns([user('q'), ...Array.from({ length: 10 }, () => say(long))], 120);
    expect(turns[0]!.replyTexts.length).toBeLessThan(10);
  });
});

describe('plainPreview', () => {
  it('drops fenced code blocks and markdown marks', () => {
    const md = [
      '## 결과 요약',
      '',
      '**굵게** 와 _기울임_ 그리고 `inline()` 코드, [링크](https://x.dev) 와 ![그림](a.png).',
      '',
      '```ts',
      'const secret = 1;',
      '```',
      '',
      '> 인용문',
      '- 항목 하나',
      '1. 번호 항목',
      '~~취소~~ <b>태그</b>',
    ].join('\n');
    expect(plainPreview(md, 500)).toBe(
      '결과 요약 굵게 와 기울임 그리고 inline() 코드, 링크 와 그림. 인용문 항목 하나 번호 항목 취소 태그',
    );
  });

  it('leaves out an unclosed fence and table separators, keeps cell text', () => {
    expect(plainPreview('| a | b |\n|---|:-:|\n| 1 | 2 |\n\n~~~py\nprint(1)', 500)).toBe('a b 1 2');
  });

  it('unescapes backslash escapes, an escaped pipe stays cell text', () => {
    expect(plainPreview('| `a\\|b` | \\*별\\* |', 500)).toBe('a|b *별*');
  });

  it('keeps snake_case and a lone asterisk', () => {
    expect(plainPreview('run my_task_name with 2 * 3', 500)).toBe('run my_task_name with 2 * 3');
  });

  it('clips at the limit with an ellipsis, counting code points', () => {
    const out = plainPreview('가'.repeat(130), 120);
    expect(Array.from(out)).toHaveLength(121);
    expect(out.endsWith('…')).toBe(true);
    expect(plainPreview('short', 120)).toBe('short');
  });
});

describe('labels', () => {
  it('firstLine skips blank lines and collapses whitespace', () => {
    expect(firstLine('\n \n  a   b \nc')).toBe('a b');
    expect(firstLine('   ')).toBe('');
  });

  it('turnLabel is "턴 N: prompt head", clipped', () => {
    expect(turnLabel({ index: 2, prompt: 'README 고쳐 줘' })).toBe('턴 3: README 고쳐 줘');
    expect(turnLabel({ index: 0, prompt: '' })).toBe('턴 1');
    expect(turnLabel({ index: 0, prompt: 'z'.repeat(80) })).toBe(`턴 1: ${'z'.repeat(40)}…`);
  });
});

describe('magnification', () => {
  it('is a gaussian: 1 at the cursor, symmetric, falling off with distance', () => {
    expect(magnification(0, 18)).toBe(1);
    expect(magnification(18, 18)).toBeCloseTo(Math.exp(-0.5), 10);
    expect(magnification(-18, 18)).toBe(magnification(18, 18));
    expect(magnification(10, 18)).toBeGreaterThan(magnification(20, 18));
    expect(magnification(200, 18)).toBeLessThan(1e-10);
    expect(magnification(5, 0)).toBe(0);
    expect(magnification(Number.NaN, 18)).toBe(0);
  });

  it('magnifyTicks peaks at the tick under the cursor and zeroes far ticks', () => {
    const mags = magnifyTicks(20, 10, 55, 18);
    expect(mags).toHaveLength(20);
    // Tick 5 is centered at 55px.
    expect(mags[5]).toBe(1);
    expect(mags[4]).toBeCloseTo(mags[6]!, 10);
    expect(mags[4]!).toBeLessThan(1);
    expect(mags[19]).toBe(0);
    expect(magnifyTicks(5, 10, null, 18)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('scrubberLayout / scrubberWindow', () => {
  it('uses the full gap while ticks fit, shrinks to the minimum, then windows', () => {
    expect(scrubberLayout(10, 400, 12, 5)).toEqual({ gap: 12, visible: 10 });
    expect(scrubberLayout(50, 400, 12, 5)).toEqual({ gap: 8, visible: 50 });
    expect(scrubberLayout(300, 400, 12, 5)).toEqual({ gap: 5, visible: 80 });
    expect(scrubberLayout(0, 400, 12, 5)).toEqual({ gap: 12, visible: 0 });
    expect(scrubberLayout(3, 0, 12, 5).visible).toBe(1);
  });

  it('centers the window on the current turn and clamps it to the ends', () => {
    expect(scrubberWindow(300, 80, 150)).toEqual({ start: 110, end: 190 });
    expect(scrubberWindow(300, 80, 3)).toEqual({ start: 0, end: 80 });
    expect(scrubberWindow(300, 80, 299)).toEqual({ start: 220, end: 300 });
    expect(scrubberWindow(300, 80, 9999)).toEqual({ start: 220, end: 300 });
    expect(scrubberWindow(10, 80, 5)).toEqual({ start: 0, end: 10 });
    // The current turn is always inside the window.
    for (const c of [0, 1, 39, 40, 41, 150, 259, 260, 299]) {
      const w = scrubberWindow(300, 80, c);
      expect(c >= w.start && c < w.end).toBe(true);
      expect(w.end - w.start).toBe(80);
    }
  });
});

describe('turn bookmarks', () => {
  it('validates item ids', () => {
    expect(isTurnItemId('user-1')).toBe(true);
    for (const bad of ['', '   ', 'a\0b', 'a\nb', 'x'.repeat(129), 3, null, undefined, {}]) expect(isTurnItemId(bad)).toBe(false);
  });

  it('sanitizes a saved list: valid unique ids in order, capped (newest kept)', () => {
    expect(sanitizeTurnBookmarks(['u1', 'u1', '', 7, 'u2', null, 'bad\n'])).toEqual(['u1', 'u2']);
    expect(sanitizeTurnBookmarks('u1')).toEqual([]);
    expect(sanitizeTurnBookmarks(undefined)).toEqual([]);
    const many = Array.from({ length: MAX_TURN_BOOKMARKS + 5 }, (_, i) => `u${i}`);
    const kept = sanitizeTurnBookmarks(many);
    expect(kept).toHaveLength(MAX_TURN_BOOKMARKS);
    expect(kept[0]).toBe('u5');
    expect(kept.at(-1)).toBe(`u${MAX_TURN_BOOKMARKS + 4}`);
  });

  it('toggles and survives a JSON round trip', () => {
    let list = toggleTurnBookmark(undefined, 'u1', true);
    list = toggleTurnBookmark(list, 'u2', true);
    list = toggleTurnBookmark(list, 'u1', true);
    expect(list).toEqual(['u2', 'u1']);
    list = toggleTurnBookmark(list, 'u2', false);
    expect(list).toEqual(['u1']);
    expect(toggleTurnBookmark(list, 'ghost', false)).toEqual(['u1']);
    expect(sanitizeTurnBookmarks(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });
});
