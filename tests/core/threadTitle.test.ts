import { describe, expect, it } from 'vitest';
import { deriveThreadTitle } from '../../src/core/threadTitle';
import { DEFAULT_THREAD_TITLE, THREAD_TITLE_MAX_CHARS } from '../../src/shared/constants';

describe('deriveThreadTitle', () => {
  it('uses the first non-blank line with whitespace collapsed', () => {
    expect(deriveThreadTitle('\n\n   Fix   the\tlogin bug  \nmore details here')).toBe('Fix the login bug');
  });

  it('keeps a title at the limit and cuts a longer one with an ellipsis', () => {
    const exact = 'a'.repeat(THREAD_TITLE_MAX_CHARS);
    expect(deriveThreadTitle(exact)).toBe(exact);
    expect(deriveThreadTitle(`${exact}b`)).toBe(`${exact}…`);
  });

  it('counts Hangul and emoji as single characters and never splits them', () => {
    const korean = '로그인 화면에서 비밀번호 재설정 링크가 동작하지 않는 문제를 고쳐 주세요 그리고 테스트도';
    const title = deriveThreadTitle(korean);
    expect(Array.from(title)).toHaveLength(THREAD_TITLE_MAX_CHARS + 1);
    expect(title.endsWith('…')).toBe(true);
    expect(korean.startsWith(title.slice(0, -1).trimEnd())).toBe(true);
    expect(deriveThreadTitle('🚀'.repeat(50), 3)).toBe('🚀🚀🚀…');
  });

  it('drops trailing spaces before the ellipsis', () => {
    expect(deriveThreadTitle('abcd efgh', 5)).toBe('abcd…');
  });

  it('falls back to the default title for blank text', () => {
    expect(deriveThreadTitle('   \n\t ')).toBe(DEFAULT_THREAD_TITLE);
  });
});
