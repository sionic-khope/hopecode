import { describe, expect, it } from 'vitest';
import { BRANCH_NAME_MAX, branchNameError } from '../../src/core/branchName';

describe('branchNameError', () => {
  it('accepts ordinary branch names', () => {
    for (const name of ['feature/login', 'fix-123', 'hopecode/abc', 'user.name/topic', 'v1.2', '한글-브랜치']) {
      expect(branchNameError(name), name).toBeNull();
    }
  });

  it('refuses what git check-ref-format --branch refuses', () => {
    const bad = [
      '',
      'has space',
      'tab\there',
      'a..b',
      '-leading',
      'tilde~1',
      'caret^',
      'colon:x',
      'q?',
      'star*',
      'open[',
      'back\\slash',
      'trailing/',
      '/leading',
      'double//slash',
      'name.lock',
      'dir/x.lock/y',
      'ends.',
      '.hidden',
      'dir/.hidden',
      'at@{1}',
      '@',
      'del\x7f',
    ];
    for (const name of bad) expect(branchNameError(name), JSON.stringify(name)).not.toBeNull();
  });

  it('caps the length', () => {
    expect(branchNameError('a'.repeat(BRANCH_NAME_MAX))).toBeNull();
    expect(branchNameError('a'.repeat(BRANCH_NAME_MAX + 1))).not.toBeNull();
  });
});
