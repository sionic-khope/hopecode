// Wires the sound engine to the app: voice blips from live `chat:event` text deltas (never from history loads, which
// do not go through events) and select / back for clicks and Escape anywhere in the document. Mount once (App).
//
// Deltas arrive in bursts of many characters; their blips go through a short queue played one per VOICE_STEP_MS
// (like a text box typing), never several at once. The queue is tiny so the voice never trails the text, and it is
// dropped -- with the ringing blip cut -- when the turn ends or the thread leaves the screen. No cue at turn end.
import { useEffect } from 'react';
import { on } from '../api';
import { useAppStore } from '../store';
import { applySoundEnabled, playSfx, playVoice, stopVoice, windowFocused } from './engine';
import { createVoiceState, feedVoice, type VoiceState } from './voicePlanner';
import { t } from '../../shared/i18n';

/** What a click lands on that counts as "clickable" (gets select / back). */
const CLICKABLE =
  'button, a[href], summary, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="button"], [role="switch"], [role="checkbox"], [role="radio"]';
/** Clicks here are typing, terminal or reading, not choosing. */
const SILENT_AREA = 'textarea, input, select, [contenteditable="true"], .xterm, .hc-diff, [data-sfx="none"]';
/** Open overlays an Escape closes (menus, popovers, modals, the palette). */
const OVERLAY = '.hc-popover, .hc-modal, .hc-palette, [role="menu"], [role="dialog"]';

/** select or back for a click on `el` (a CLICKABLE match), or null when it plays nothing of its own. */
export function clickSfx(el: Element): 'select' | 'back' | null {
  const own = el.getAttribute('data-sfx');
  if (own === 'back' || own === 'select') return own;
  // The send button plays `send` from the composer.
  if (el.classList.contains('hc-send')) return null;
  const label = (el.getAttribute('aria-label') ?? '').trim();
  const text = (el.textContent ?? '').trim();
  // Back / close / cancel by their label in the current language.
  const cancel = t('common.cancel');
  if (label === t('common.back') || label === t('common.close') || text.endsWith(cancel) || label.startsWith(cancel)) return 'back';
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

/** One blip per this many ms while the queue has entries (about the game's text speed). */
export const VOICE_STEP_MS = 66;
/** Queued blips beyond this are dropped (oldest first): the voice keeps up with the text instead of trailing it. */
export const VOICE_QUEUE_MAX = 3;

/** Planner state per thread, for the reply item it is following. */
interface Track {
  itemId: string | null;
  state: VoiceState;
}

export function useSound(): void {
  useEffect(() => {
    const tracks = new Map<string, Track>();
    /** Pending blips of the one thread that may speak (the one on screen). */
    let queue: { threadId: string; itemId: string; agent: Parameters<typeof playVoice>[0]; pos: number }[] = [];
    let timer: ReturnType<typeof setInterval> | null = null;

    const silence = (): void => {
      queue = [];
      if (timer) clearInterval(timer);
      timer = null;
      stopVoice();
    };
    const speaking = (threadId: string): boolean => {
      const s = useAppStore.getState();
      return s.route === 'chat' && s.selectedThreadId === threadId && windowFocused();
    };
    const step = (): void => {
      const next = queue.shift();
      if (!next || !speaking(next.threadId)) {
        silence();
        return;
      }
      playVoice(next.agent, { threadId: next.threadId, itemId: next.itemId, pos: next.pos });
    };

    const offEvents = on('chat:event', ({ threadId, event }) => {
      if (event.type === 'turn-start' || event.type === 'turn-end') {
        tracks.delete(threadId);
        if (queue[0]?.threadId === threadId || queue.length === 0) silence();
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
      if (blips.length === 0 || !speaking(threadId)) return;
      const thread = useAppStore.getState().threads.find((t) => t.id === threadId);
      if (!thread) return;
      if (queue.length > 0 && queue[0]!.threadId !== threadId) silence();
      for (const pos of blips) queue.push({ threadId, itemId: event.itemId, agent: thread.agent, pos });
      if (queue.length > VOICE_QUEUE_MAX) queue.splice(0, queue.length - VOICE_QUEUE_MAX);
      if (!timer) {
        step();
        timer = setInterval(step, VOICE_STEP_MS);
      }
    });
    const offStore = useAppStore.subscribe((s, prev) => {
      if (s.settings.soundEnabled !== prev.settings.soundEnabled) applySoundEnabled(s.settings.soundEnabled);
      if (s.selectedThreadId !== prev.selectedThreadId || s.route !== prev.route) silence();
    });
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      silence();
      offEvents();
      offStore();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
}
