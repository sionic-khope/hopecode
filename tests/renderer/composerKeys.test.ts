import { describe, expect, it } from 'vitest';
import { isSubmitKey } from '../../src/renderer/components/Chat/composerKeys';

describe('isSubmitKey (H2: IME-safe Enter)', () => {
  it('plain Enter submits', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 })).toBe(true);
  });

  it('Shift+Enter inserts a newline', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('Enter that commits a 한글 composition does not submit', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 })).toBe(false);
    // Chromium reports keyCode 229 for keys the IME consumes (isComposing may already be false).
    expect(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false);
  });

  it('other keys never submit', () => {
    expect(isSubmitKey({ key: 'a', shiftKey: false })).toBe(false);
  });
});
