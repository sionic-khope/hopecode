// Wires the sound engine to the app: voice blips from live `chat:event` text deltas (never from history loads, which
// do not go through events), done when a turn finishes, and select / back for clicks and Escape anywhere in the
// document. Mount once (App).
import { useEffect } from 'react';
import { on } from '../api';
import { useAppStore } from '../store';
import { applySoundEnabled, playSfx, playVoice, windowFocused } from './engine';
import { createVoiceState, feedVoice, type VoiceState } from './voicePlanner';

/** What a click lands on that counts as "clickable" (gets select / back). */
const CLICKABLE =
  'button, a[href], summary, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="button"], [role="switch"], [role="checkbox"], [role="radio"]';
/** Clicks here are typing, terminal or reading, not choosing. */
const SILENT_AREA = 'textarea, input, select, [contenteditable="true"], .xterm, .hc-diff, [data-sfx="none"]';
/** Open overlays an Escape closes (menus, popovers, modals, the palette). */
const OVERLAY = '.hc-popover, .hc-modal, .hc-palette, [role="menu"], [role="dialog"]';
const BACK_LABELS = new Set(['뒤로', '닫기']);

/** select or back for a click on `el` (a CLICKABLE match), or null when it plays nothing of its own. */
export function clickSfx(el: Element): 'select' | 'back' | null {
  const own = el.getAttribute('data-sfx');
  if (own === 'back' || own === 'select') return own;
  // The send button plays `send` from the composer.
  if (el.classList.contains('hc-send')) return null;
  const label = (el.getAttribute('aria-label') ?? '').trim();
  const text = (el.textContent ?? '').trim();
  if (BACK_LABELS.has(label) || /취소$/.test(text) || /^취소/.test(label)) return 'back';
  return 'select';
}

function onClick(e: MouseEvent): void {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (target.closest(SILENT_AREA)) return;
  // Clicking a modal / palette backdrop closes it.
  if (target.classList.contains('hc-modal-backdrop') || target.classList.contains('hc-palette-backdrop')) {
    playSfx('back');
    return;
  }
  const el = target.closest(CLICKABLE);
  if (!el) return;
  const kind = clickSfx(el);
  if (kind) playSfx(kind);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing) return;
  // Capture phase: the overlay is still in the DOM, its own handler closes it right after.
  if (document.querySelector(OVERLAY)) playSfx('back');
}

/** Planner state per thread, for the reply item it is following. */
interface Track {
  itemId: string | null;
  state: VoiceState;
}

export function useSound(): void {
  useEffect(() => {
    const tracks = new Map<string, Track>();
    const offEvents = on('chat:event', ({ threadId, event }) => {
      if (event.type === 'turn-start') {
        tracks.delete(threadId);
        return;
      }
      if (event.type === 'turn-end') {
        tracks.delete(threadId);
        if (event.ok && windowFocused()) playSfx('done');
        return;
      }
      if (event.type !== 'text-delta') return;
      let track = tracks.get(threadId);
      if (!track || track.itemId !== event.itemId) {
        // A new text item of the same turn: fresh fence / position tracking, but the turn's fade keeps counting.
        const fresh = createVoiceState();
        track = {
          itemId: event.itemId,
          state: track ? { ...fresh, voiced: track.state.voiced, lastAt: track.state.lastAt } : fresh,
        };
        tracks.set(threadId, track);
      }
      // Always feed the planner (code fences stay tracked); speak only for the thread on screen in a focused window.
      const { state, blips } = feedVoice(track.state, event.text, performance.now());
      track.state = state;
      if (blips.length === 0) return;
      const s = useAppStore.getState();
      if (s.route !== 'chat' || s.selectedThreadId !== threadId || !windowFocused()) return;
      const thread = s.threads.find((t) => t.id === threadId);
      if (!thread) return;
      for (const pos of blips) playVoice(thread.agent, { threadId, itemId: event.itemId, pos });
    });
    const offStore = useAppStore.subscribe((s, prev) => {
      if (s.settings.soundEnabled !== prev.settings.soundEnabled) applySoundEnabled(s.settings.soundEnabled);
    });
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      offEvents();
      offStore();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
}
