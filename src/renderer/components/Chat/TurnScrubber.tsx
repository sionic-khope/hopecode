// Turn scrubber: the conversation's minimap on the left edge of the message list (ChatGPT desktop style, drawn as a
// column of pixel ticks). One tick per user message; the turn at the top of the viewport is long and white, bookmarks
// are yellow, the running turn blinks cyan. Hovering magnifies the ticks near the cursor (Dock style) and shows a
// preview card; a click (tick or card) scrolls to that message. ⌥↑ / ⌥↓ step between turns from anywhere in the chat.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  magnifyTicks,
  scrubberLayout,
  scrubberWindow,
  turnLabel,
  turnReplyPreview,
  type TurnSource,
} from '../../../core/turnScrubber';
import { playSfx } from '../../sound/engine';
import { useLanguage } from '../../i18n';
import { t } from '../../../shared/i18n';

/** Distance between tick centers while every tick fits / the closest they may get before the window kicks in. */
export const TICK_GAP_MAX = 12;
export const TICK_GAP_MIN = 5;
/** Gaussian sigma of the hover magnification (px). */
const MAGNIFY_SIGMA = 18;
/** Vertical padding of the scrubber column (px). */
const PAD_Y = 16;
/**
 * IntersectionObserver zone: everything above a line 20% down the scroll viewport. A user message inside it has been
 * reached; the zone reaches far above the viewport so a jump past the line in either direction is always reported.
 */
const READ_ZONE = '1000000px 0px -80% 0px';
/** How long the arrival frame stays on the message scrolled to (ms). */
const ARRIVE_MS = 1400;
/** Scroll-idle time after a jump before the observed position takes over again (ms). */
const SETTLE_MS = 160;
/** Messages are scrolled to this far below the top edge (px). */
const JUMP_OFFSET = 12;

/** Typing targets where ⌥↑ / ⌥↓ already mean "caret to paragraph start / end". */
const EDITABLE = 'textarea, input, select, [contenteditable="true"], [contenteditable=""], .cm-editor, .xterm';
/** Open overlays own the keyboard. */
const OVERLAY = '.hc-popover, .hc-modal, .hc-palette, [role="menu"], [role="dialog"], [role="listbox"]';

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function turnElement(scroller: HTMLElement, id: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
}

/** Should ⌥↑ / ⌥↓ go to the scrubber for a keydown on `target`? Not while it would move a caret in text. */
function altArrowFree(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  const editable = target.closest(EDITABLE);
  if (!editable) return true;
  // An empty single field (the idle composer) has no caret to move.
  if (editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement) return editable.value === '';
  return false;
}

export interface TurnScrubberProps {
  turns: readonly TurnSource[];
  /** The message list's scroll container. */
  scrollRef: RefObject<HTMLDivElement | null>;
  bookmarks: ReadonlySet<string>;
  /** The last turn is still running (cyan blink). */
  running: boolean;
  onToggleBookmark: (itemId: string, bookmarked: boolean) => void;
}

export function TurnScrubber({ turns, scrollRef, bookmarks, running, onToggleBookmark }: TurnScrubberProps) {
  const navRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const tickEls = useRef<(HTMLButtonElement | null)[]>([]);
  const count = turns.length;

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [avail, setAvail] = useState(0);
  const [pointerInside, setPointerInside] = useState(false);

  // ---- available height (ResizeObserver) ----
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => setAvail(Math.max(0, nav.clientHeight - 2 * PAD_Y));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, []);

  // ---- current turn ----
  // The last user message that reached the top of the viewport (IntersectionObserver); at the very end of the
  // conversation the last turn (it may be too short to ever reach the top); right after a jump, the turn jumped to
  // until the user scrolls on their own.
  const [observed, setObserved] = useState(() => Math.max(0, count - 1));
  const [atBottom, setAtBottom] = useState(true);
  const [pinned, setPinned] = useState<number | null>(null);
  const jumping = useRef(false);
  const jumpTarget = useRef(0);
  const jumpDist = useRef(0);
  const settleTimer = useRef<number | undefined>(undefined);
  const turnIds = useMemo(() => turns.map((t) => t.id).join('\n'), [turns]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || count === 0) return;
    const bottomNow = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4;
    const reached = new Array<boolean>(count).fill(false);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.turnIndex);
          if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
          reached[idx] = e.isIntersecting;
        }
        let last = 0;
        for (let i = count - 1; i >= 0; i--) {
          if (reached[i]) {
            last = i;
            break;
          }
        }
        setObserved(last);
        setAtBottom(bottomNow());
      },
      { root: scroller, rootMargin: READ_ZONE, threshold: 0 },
    );
    turnIds.split('\n').forEach((id, i) => {
      const el = turnElement(scroller, id);
      if (!el) return;
      el.dataset.turnIndex = String(i);
      io.observe(el);
    });
    let raf = 0;
    const onScroll = () => {
      if (jumping.current) {
        // The jump's own smooth scroll closes in on its target: done once it arrives (or goes quiet). A scroll that
        // moves away from the target is the user's (or another scroll) taking over.
        window.clearTimeout(settleTimer.current);
        const dist = Math.abs(scroller.scrollTop - jumpTarget.current);
        if (dist < 2) jumping.current = false;
        else if (dist > jumpDist.current + 1) {
          jumping.current = false;
          setPinned(null);
        } else {
          jumpDist.current = dist;
          settleTimer.current = window.setTimeout(() => (jumping.current = false), SETTLE_MS);
        }
      } else setPinned(null);
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        setAtBottom(bottomNow());
      });
    };
    setAtBottom(bottomNow());
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      io.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [scrollRef, turnIds, count]);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  const cur = Math.min(pinned ?? (atBottom ? count - 1 : observed), Math.max(0, count - 1));

  // ---- jump ----
  const arriveTimer = useRef<{ el: HTMLElement; id: number } | null>(null);
  const jumpTo = useCallback(
    (index: number) => {
      const scroller = scrollRef.current;
      const turn = turns[index];
      if (!scroller || !turn) return;
      const el = turnElement(scroller, turn.id);
      if (!el) return;
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - JUMP_OFFSET;
      jumping.current = true;
      jumpTarget.current = Math.min(Math.max(0, top), scroller.scrollHeight - scroller.clientHeight);
      jumpDist.current = Math.abs(scroller.scrollTop - jumpTarget.current);
      window.clearTimeout(settleTimer.current);
      // No scroll event at all (already there): release the lock on its own.
      settleTimer.current = window.setTimeout(() => (jumping.current = false), SETTLE_MS * 4);
      setPinned(index);
      scroller.scrollTo({ top: jumpTarget.current, behavior: reducedMotion() ? 'auto' : 'smooth' });
      // Arrival frame: restart it on the new target.
      const prev = arriveTimer.current;
      if (prev) {
        window.clearTimeout(prev.id);
        prev.el.classList.remove('hc-msg-user--arrive');
      }
      el.classList.remove('hc-msg-user--arrive');
      void el.offsetWidth;
      el.classList.add('hc-msg-user--arrive');
      arriveTimer.current = {
        el,
        id: window.setTimeout(() => {
          el.classList.remove('hc-msg-user--arrive');
          arriveTimer.current = null;
        }, ARRIVE_MS),
      };
    },
    [scrollRef, turns],
  );
  useEffect(
    () => () => {
      const prev = arriveTimer.current;
      if (prev) {
        window.clearTimeout(prev.id);
        prev.el.classList.remove('hc-msg-user--arrive');
      }
    },
    [],
  );

  // ---- global ⌥↑ / ⌥↓ ----
  const curRef = useRef(cur);
  curRef.current = cur;
  const jumpRef = useRef(jumpTo);
  jumpRef.current = jumpTo;
  const countRef = useRef(count);
  countRef.current = count;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.isComposing || e.defaultPrevented) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (!altArrowFree(e.target) || document.querySelector(OVERLAY)) return;
      const next = curRef.current + (e.key === 'ArrowUp' ? -1 : 1);
      e.preventDefault();
      if (next < 0 || next >= countRef.current) return;
      playSfx('move');
      jumpRef.current(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- layout + overflow window ----
  const layout = scrubberLayout(count, avail, TICK_GAP_MAX, TICK_GAP_MIN);
  const frozenStart = useRef(0);
  const centerIdx = focusIdx ?? cur;
  let win = scrubberWindow(count, layout.visible, centerIdx);
  // Under the pointer the window holds still (ticks must not slide away from the cursor).
  if (pointerInside && layout.visible < count) {
    const start = Math.min(Math.max(0, frozenStart.current), count - layout.visible);
    win = { start, end: start + layout.visible };
  }
  frozenStart.current = win.start;
  const trackH = (win.end - win.start) * layout.gap;

  // ---- hover magnification (direct style writes, one rAF per frame) ----
  const pointerY = useRef<number | null>(null);
  const magRaf = useRef(0);
  const lastMag = useRef<number[]>([]);
  const applyMagnify = useCallback(() => {
    magRaf.current = 0;
    const els = tickEls.current;
    const visible = win.end - win.start;
    const reduce = reducedMotion();
    const y = pointerY.current;
    let mags: number[];
    if (y === null) mags = new Array<number>(visible).fill(0);
    else if (reduce) {
      // Reduced motion: only the tick under the pointer grows, no wave across its neighbours.
      mags = new Array<number>(visible).fill(0);
      const i = Math.floor(y / layout.gap);
      if (i >= 0 && i < visible) mags[i] = 1;
    } else mags = magnifyTicks(visible, layout.gap, y, MAGNIFY_SIGMA);
    for (let i = 0; i < visible; i++) {
      const el = els[i];
      const m = Math.round((mags[i] ?? 0) * 100) / 100;
      if (!el || lastMag.current[i] === m) continue;
      lastMag.current[i] = m;
      el.style.setProperty('--mag', String(m));
    }
  }, [win.start, win.end, layout.gap]);
  const scheduleMagnify = useCallback(() => {
    if (!magRaf.current) magRaf.current = window.requestAnimationFrame(applyMagnify);
  }, [applyMagnify]);
  useEffect(() => () => window.cancelAnimationFrame(magRaf.current), []);
  // New window / spacing: the cached values belong to other ticks.
  useLayoutEffect(() => {
    lastMag.current = [];
    for (const el of tickEls.current) el?.style.setProperty('--mag', '0');
    applyMagnify();
  }, [applyMagnify]);

  const onPointerMove = (e: React.PointerEvent) => {
    const track = trackRef.current;
    if (!track) return;
    // Over the preview card the magnification stays where the pointer left the ticks.
    if (cardRef.current?.contains(e.target as Node)) return;
    const y = e.clientY - track.getBoundingClientRect().top;
    pointerY.current = y;
    const i = Math.floor(y / layout.gap);
    setHoverIdx(i >= 0 && i < win.end - win.start ? win.start + i : null);
    scheduleMagnify();
  };
  const onPointerEnter = () => setPointerInside(true);
  const onPointerLeave = () => {
    setPointerInside(false);
    setHoverIdx(null);
    pointerY.current = null;
    scheduleMagnify();
  };
  // The scrubber sits outside the scroller: the wheel still scrolls the conversation.
  const onWheel = (e: React.WheelEvent) => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop += e.deltaY;
  };

  // ---- keyboard inside the scrubber ----
  const focusTick = useRef<number | null>(null);
  useEffect(() => {
    const target = focusTick.current;
    if (target === null) return;
    focusTick.current = null;
    tickEls.current[target - win.start]?.focus({ preventScroll: true });
  });
  const toggleBookmark = useCallback(
    (index: number) => {
      const turn = turns[index];
      if (!turn) return;
      const on = !bookmarks.has(turn.id);
      playSfx(on ? 'select' : 'back');
      onToggleBookmark(turn.id, on);
    },
    [turns, bookmarks, onToggleBookmark],
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
    const at = focusIdx ?? cur;
    let next: number | null = null;
    if (e.key === 'ArrowUp') next = at - 1;
    else if (e.key === 'ArrowDown') next = at + 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    else if (e.key === 'b' || e.key === 'B' || e.key === 'ㅠ') {
      e.preventDefault();
      toggleBookmark(at);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    const clamped = Math.min(Math.max(0, next), count - 1);
    if (clamped !== at) playSfx('move');
    setFocusIdx(clamped);
    focusTick.current = clamped;
  };
  const onTickFocus = useCallback((index: number, el: HTMLButtonElement) => {
    // Mouse clicks focus the tick too; only keyboard focus keeps a card open without the pointer.
    if (el.matches(':focus-visible')) setFocusIdx(index);
  }, []);
  // Stable for the memoized ticks (the turn list changes on every streamed delta).
  const jumpStable = useCallback((index: number) => jumpRef.current(index), []);
  const onNavBlur = (e: React.FocusEvent) => {
    if (!navRef.current?.contains(e.relatedTarget as Node | null)) setFocusIdx(null);
  };

  // ---- preview card ----
  const cardIdx = hoverIdx ?? focusIdx;
  const cardTurn = cardIdx !== null ? turns[cardIdx] : undefined;
  const cardTickY = cardIdx !== null ? PAD_Y + (avail - trackH) / 2 + (cardIdx - win.start + 0.5) * layout.gap : 0;
  useLayoutEffect(() => {
    const card = cardRef.current;
    const nav = navRef.current;
    if (!card || !nav || cardIdx === null) return;
    const h = card.offsetHeight;
    // The prompt line sits level with the tick; the card stays inside the column.
    const y = Math.min(Math.max(4, cardTickY - 22), Math.max(4, nav.clientHeight - h - 4));
    card.style.setProperty('--card-y', `${Math.round(y)}px`);
  });

  const roving = focusIdx ?? cur;
  const lastIdx = count - 1;
  const ticks: React.ReactNode[] = [];
  tickEls.current.length = win.end - win.start;
  for (let i = win.start; i < win.end; i++) {
    const turn = turns[i]!;
    const slot = i - win.start;
    ticks.push(
      <Tick
        key={turn.id}
        index={i}
        label={turnLabel(turn)}
        current={i === cur}
        bookmarked={bookmarks.has(turn.id)}
        live={running && i === lastIdx}
        hovered={i === cardIdx}
        tabbable={i === roving}
        gap={layout.gap}
        onJump={jumpStable}
        onFocusTick={onTickFocus}
        refAt={slot}
        refs={tickEls}
      />,
    );
  }

  return (
    <nav
      ref={navRef}
      className="hc-scrubber"
      aria-label={t('scrubber.aria')}
      data-testid="turn-scrubber"
      data-count={count}
      data-current={cur}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onBlur={onNavBlur}
    >
      <div
        ref={trackRef}
        className="hc-scrubber__track"
        style={{ height: trackH }}
        data-clip-top={win.start > 0 || undefined}
        data-clip-bottom={win.end < count || undefined}
      >
        {ticks}
      </div>
      {cardTurn ? (
        <PreviewCard
          cardRef={cardRef}
          turn={cardTurn}
          total={count}
          bookmarked={bookmarks.has(cardTurn.id)}
          live={running && cardTurn.index === lastIdx}
          onJump={jumpTo}
          onToggleBookmark={toggleBookmark}
        />
      ) : null}
    </nav>
  );
}

const Tick = memo(function Tick({
  index,
  label,
  current,
  bookmarked,
  live,
  hovered,
  tabbable,
  gap,
  onJump,
  onFocusTick,
  refAt,
  refs,
}: {
  index: number;
  label: string;
  current: boolean;
  bookmarked: boolean;
  live: boolean;
  hovered: boolean;
  tabbable: boolean;
  gap: number;
  onJump: (index: number) => void;
  onFocusTick: (index: number, el: HTMLButtonElement) => void;
  refAt: number;
  refs: RefObject<(HTMLButtonElement | null)[]>;
}) {
  useLanguage();
  return (
    <button
      type="button"
      ref={(el) => {
        refs.current[refAt] = el;
      }}
      className="hc-scrubber__tick"
      style={{ height: gap }}
      aria-label={label}
      aria-current={current ? 'true' : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-testid="turn-tick"
      data-index={index}
      data-current={current || undefined}
      data-bookmarked={bookmarked || undefined}
      data-live={live || undefined}
      data-hover={hovered || undefined}
      onClick={() => onJump(index)}
      onFocus={(e) => onFocusTick(index, e.currentTarget)}
    >
      <span className="hc-scrubber__bar" aria-hidden="true" />
    </button>
  );
});

/** Pixel ribbon (12x14): outline, filled when bookmarked. */
function GlyphBookmark({ filled }: { filled: boolean }) {
  return (
    <svg width={12} height={14} viewBox="0 0 12 14" shapeRendering="crispEdges" aria-hidden="true">
      {filled ? (
        <path d="M1 0h10v14h-1v-1H9v-1H8v-1H7v-1H5v1H4v1H3v1H2v1H1z" fill="currentColor" />
      ) : (
        <path
          d="M1 0h10v14h-1v-1H9v-1H8v-1H7v-1H5v1H4v1H3v1H2v1H1zM3 2v8h1V9h1V8h2v1h1v1h1V2z"
          fill="currentColor"
          fillRule="evenodd"
        />
      )}
    </svg>
  );
}

const PreviewCard = memo(function PreviewCard({
  cardRef,
  turn,
  total,
  bookmarked,
  live,
  onJump,
  onToggleBookmark,
}: {
  cardRef: RefObject<HTMLDivElement | null>;
  turn: TurnSource;
  total: number;
  bookmarked: boolean;
  live: boolean;
  onJump: (index: number) => void;
  onToggleBookmark: (index: number) => void;
}) {
  useLanguage();
  // Only the card's turn is ever reduced to preview text (never the whole transcript per streamed delta).
  const replySource = turn.replyTexts.join('\n\n');
  const reply = useMemo(() => turnReplyPreview({ replyTexts: [replySource] }), [replySource]);
  const pad = String(total).length;
  return (
    <div
      ref={cardRef}
      className="hc-scrubber__card"
      data-testid="turn-preview"
      data-bookmarked={bookmarked || undefined}
      onClick={() => {
        playSfx('select');
        onJump(turn.index);
      }}
    >
      <div className="hc-scrubber__card-head">
        <span className="hc-scrubber__card-tag">
          TURN {String(turn.index + 1).padStart(pad, '0')}/{total}
        </span>
        <button
          type="button"
          className="hc-scrubber__mark"
          data-sfx="none"
          tabIndex={-1}
          aria-pressed={bookmarked}
          aria-label={bookmarked ? t('scrubber.unbookmark') : t('scrubber.bookmark')}
          title={`${bookmarked ? t('scrubber.unbookmark') : t('scrubber.bookmark')} (B)`}
          data-testid="turn-bookmark"
          onClick={(e) => {
            e.stopPropagation();
            onToggleBookmark(turn.index);
          }}
        >
          <GlyphBookmark filled={bookmarked} />
        </button>
      </div>
      <p className="hc-scrubber__prompt" data-testid="turn-preview-prompt">
        {turn.prompt || t('scrubber.emptyMessage')}
      </p>
      <p className="hc-scrubber__reply" data-testid="turn-preview-reply" data-empty={reply === '' || undefined}>
        {reply || (live ? t('scrubber.replying') : t('scrubber.noReply'))}
      </p>
    </div>
  );
});
