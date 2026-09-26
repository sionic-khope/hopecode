import { describe, expect, it } from 'vitest';
import { displayPath } from '../../src/core/displayPath';

describe('displayPath', () => {
  it('is relative inside cwd', () => {
    expect(displayPath('/w/repo/src/a.ts', '/w/repo', '/Users/me')).toBe('src/a.ts');
    expect(displayPath('/w/repo', '/w/repo/', null)).toBe('.');
  });
  it('uses ~ inside home but outside cwd', () => {
    expect(displayPath('/Users/me/x/y.md', '/w/repo', '/Users/me')).toBe('~/x/y.md');
  });
  it('does not match a sibling prefix', () => {
    expect(displayPath('/w/repo2/a.ts', '/w/repo', null)).toBe('/w/repo2/a.ts');
  });
  it('leaves other paths unchanged', () => {
    expect(displayPath('/etc/hosts', '/w/repo', '/Users/me')).toBe('/etc/hosts');
  });
});
