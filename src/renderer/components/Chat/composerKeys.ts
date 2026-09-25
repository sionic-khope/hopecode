/** Subset of a keydown event needed to decide whether Enter submits. */
export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  /** `KeyboardEvent.isComposing` (native event). */
  isComposing?: boolean;
  /** 229 while an IME (e.g. Korean/Japanese) owns the keystroke. */
  keyCode?: number;
}

/**
 * ⏎ sends, ⇧⏎ inserts a newline. An Enter that commits an IME composition (한글 등) must not send: the
 * browser reports it with `isComposing` or keyCode 229 (H2).
 */
export function isSubmitKey(e: ComposerKeyEvent): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}
