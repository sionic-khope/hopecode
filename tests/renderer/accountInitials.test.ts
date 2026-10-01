import { describe, expect, it } from 'vitest';
import { accountInitials } from '../../src/renderer/components/Sidebar/ProfileRow';

const acc = (alias: string, email: string | null = null) => ({ alias, email });

describe('accountInitials', () => {
  it('Hangul gives the first character, brackets ignored', () => {
    expect(accountInitials(acc('로컬 (기본)'))).toBe('로');
    expect(accountInitials(acc('x'), '케이홉')).toBe('케');
  });
  it('Latin gives up to two uppercase word initials', () => {
    expect(accountInitials(acc('work account'))).toBe('WA');
    expect(accountInitials(acc('khope'))).toBe('K');
    expect(accountInitials(acc('(personal) main team'))).toBe('PM');
  });
  it('falls back to the email local part, then ?', () => {
    expect(accountInitials(acc('', 'jane.doe@x.com'))).toBe('JD');
    expect(accountInitials(acc('', null))).toBe('?');
    expect(accountInitials(acc('()'))).toBe('?');
  });
});
