import { memo, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Menu, type MenuSection } from '../common';
import { COMPOSER_MENU_WIDTH } from './ComposerControls';
import { FolderOpenIcon, PaperclipIcon, PlusIcon, SpinnerIcon, StopIcon } from './icons';
import { isSubmitKey } from './composerKeys';
import { playSfx } from '../../sound/engine';
import type { ChatImage } from '../../../shared/types';
import { ComposerImageTray, useComposerImages } from '../Images/ComposerImages';
import { SlashMenu, slashOptionId, useSlashItems, type SlashSource } from './SlashMenu';
import { applySlashChoice, expandSlashLabel, filterSlashCommands, sendsOnEnter, slashTokenAt } from './slashCommands';
import './Chat.css';

export const COMPOSER_PLACEHOLDER = '무엇이든 요청하세요';

/** Imperative handle: the draft screen focuses the composer, attachments insert mentions. */
export interface ComposerHandle {
  focus(): void;
  /** Replaces the text (suggested prompt, "편집해서 다시 보내기") and puts the caret at the end. */
  setText(text: string): void;
}

export interface ComposerProps {
  /**
   * Returns (or resolves) `true` when the text was taken (the box clears), `false` to keep it — e.g. a draft
   * without a folder, or a start that failed.
   */
  onSend: (text: string, images?: ChatImage[]) => boolean | Promise<boolean>;
  /** Paste / drop images to send with the message (image content blocks); off = text only. */
  acceptImages?: boolean;
  onInterrupt?: () => void;
  /** A turn is running: the send button becomes Stop. */
  running: boolean;
  /** Blocks typing and sending (e.g. while a draft thread is being created). */
  disabled?: boolean;
  /** Shows a spinner in the send button (draft being started). */
  busy?: boolean;
  placeholder?: string;
  /** Chips left of the spacer (agent, folder, permission). */
  leading?: ReactNode;
  /** Controls right of the spacer, before the send button (model picker). */
  trailing?: ReactNode;
  /** "파일 첨부": resolves `@` mentions to insert (empty when cancelled). */
  onAttachFiles?: () => Promise<string[]>;
  /** "폴더 변경": enabled only while the chat has not started. */
  onChangeFolder?: () => void;
  canChangeFolder?: boolean;
  autoFocus?: boolean;
  /** Visual size: the draft screen uses the roomier variant. */
  size?: 'md' | 'lg';
  handleRef?: Ref<ComposerHandle>;
  /**
   * Text to place in the box once per `nonce` (store composerPrefill); `onPrefillApplied` clears it.
   * `mode: 'prepend'` keeps whatever the box already held, with `text` placed in front (empty box: just `text`).
   */
  prefill?: { text: string; nonce: number; mode?: 'replace' | 'prepend' } | null;
  onPrefillApplied?: () => void;
  /** `/` at the start of the input (or of a line) opens the command / skill picker with these rows. */
  slash?: SlashSource;
  /** Shortens file paths in the picker preview (`~/…`). */
  homeDir?: string | null;
}

/** Widest the `/` picker gets (it otherwise matches the composer card). */
const SLASH_MENU_MAX_W = 760;

const MAX_HEIGHT_PX = 240;

/**
 * Codex-style composer card: multiline input on top, one control row below (+ menu, chips, model picker,
 * round send / stop). ⏎ sends, ⇧⏎ inserts a newline, an Enter that commits a 한글 IME composition does not send.
 */
export const Composer = memo(function Composer({
  onSend,
  onInterrupt,
  running,
  disabled = false,
  busy = false,
  placeholder = COMPOSER_PLACEHOLDER,
  leading,
  trailing,
  onAttachFiles,
  onChangeFolder,
  canChangeFolder = false,
  autoFocus = false,
  size = 'md',
  handleRef,
  prefill = null,
  onPrefillApplied,
  acceptImages = false,
  slash,
  homeDir = null,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [plusOpen, setPlusOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);

  // Caret to place once the replaced text is committed. Applied in a layout effect, not a later frame: a deferred
  // setSelectionRange could land after the user (or a test) already selected or typed in the new text.
  const pendingCaret = useRef<number | null>(null);
  const replaceText = (next: string) => {
    const el = taRef.current;
    if (el && el.value === next) {
      el.focus();
      el.setSelectionRange(next.length, next.length);
      return;
    }
    pendingCaret.current = next.length;
    setText(next);
  };

  useLayoutEffect(() => {
    const el = taRef.current;
    const caret = pendingCaret.current;
    if (!el || caret === null) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
    setCaret(caret);
  }, [text]);

  useImperativeHandle(handleRef, () => ({ focus: () => taRef.current?.focus(), setText: replaceText }), []);

  useEffect(() => {
    if (!prefill) return;
    if (prefill.mode === 'prepend') {
      const current = taRef.current?.value ?? '';
      replaceText(current.trim().length === 0 ? prefill.text : `${prefill.text}\n\n${current}`);
    } else {
      replaceText(prefill.text);
    }
    onPrefillApplied?.();
    // One application per request (nonce); the callback identity does not matter.
  }, [prefill?.nonce]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  const attachments = useComposerImages(acceptImages);

  // `/` picker: open while the caret sits in a `/query` token; Escape / an outside click hide it until the next edit.
  const cardRef = useRef<HTMLDivElement>(null);
  const slashListId = useId();
  const token = slash && !disabled ? slashTokenAt(text, caret) : null;
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const slashActive = token !== null && dismissedAt !== token.start;
  const { items: slashItems, emptyHint: slashHint } = useSlashItems(slash, slashActive);
  const matches = slashActive ? filterSlashCommands(slashItems, token.query) : [];
  const [activeIndex, setActiveIndex] = useState(0);
  const slashOpen = slashActive && (matches.length > 0 || (slashItems.length === 0 && !!slashHint));
  const active = Math.min(activeIndex, Math.max(0, matches.length - 1));

  useEffect(() => {
    setActiveIndex(0);
  }, [token?.query, token?.start]);

  const closeSlash = () => {
    if (!token) return;
    playSfx('back');
    setDismissedAt(token.start);
  };

  /** Completes the token to `/name ` (Tab, or Enter on a command that takes arguments) or sends `/name`. */
  const chooseSlash = (index: number, viaEnter: boolean) => {
    const item = matches[index];
    if (!item || !token) return;
    playSfx('select');
    if (viaEnter && sendsOnEnter(item, text, token)) {
      submit(`/${item.name}`);
      return;
    }
    const next = applySlashChoice(text, token, item.label);
    pendingCaret.current = next.caret;
    setText(next.text);
  };

  const submit = (override?: string) => {
    const trimmed = expandSlashLabel((override ?? text).trim(), slashItems);
    if (!trimmed || disabled || busy) return;
    playSfx('send');
    const images = attachments.images;
    void Promise.resolve(images.length > 0 ? onSend(trimmed, images) : onSend(trimmed)).then((taken) => {
      if (!taken) return;
      setText('');
      if (images.length > 0) attachments.clear();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && matches.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = (active + step + matches.length) % matches.length;
        if (next !== active) playSfx('move');
        setActiveIndex(next);
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        chooseSlash(active, false);
        return;
      }
      if (isSubmitKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) {
        e.preventDefault();
        chooseSlash(active, true);
        return;
      }
    }
    if (!isSubmitKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return;
    e.preventDefault();
    submit();
  };

  /** Inserts mentions at the caret, padded with spaces so they stay separate tokens. */
  const insertMentions = (mentions: string[]) => {
    if (mentions.length === 0) return;
    const el = taRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const insert = `${lead}${mentions.join(' ')} `;
    const next = `${before}${insert}${after.replace(/^ /, '')}`;
    setText(next);
    requestAnimationFrame(() => {
      const caret = before.length + insert.length;
      taRef.current?.focus();
      taRef.current?.setSelectionRange(caret, caret);
    });
  };

  const plusSections: MenuSection[] = [
    {
      key: 'add',
      kind: 'action',
      items: [
        {
          key: 'attach',
          label: '파일 첨부',
          description: '@경로로 입력창에 추가',
          icon: <PaperclipIcon />,
          disabled: !onAttachFiles,
          onSelect: () => {
            void onAttachFiles?.()
              .then(insertMentions)
              .catch((err: unknown) => console.error('[hopecode] attach failed', err));
          },
        },
        {
          key: 'folder',
          label: '폴더 변경',
          description: canChangeFolder ? '이 채팅을 시작할 폴더' : '시작된 채팅은 폴더를 바꿀 수 없어요',
          icon: <FolderOpenIcon />,
          disabled: !canChangeFolder || !onChangeFolder,
          onSelect: () => onChangeFolder?.(),
        },
      ],
    },
  ];

  const canSend = !disabled && !busy && text.trim().length > 0;
  const hasText = text.trim().length > 0;

  return (
    <div className={`hc-composer hc-composer--${size}`}>
      <div
        ref={cardRef}
        className={`hc-composer__card${disabled ? ' hc-composer__card--disabled' : ''}${attachments.dragging ? ' hc-composer__card--dragging' : ''}`}
        {...attachments.dropProps}
      >
        <ComposerImageTray images={attachments.images} error={attachments.error} onRemove={attachments.remove} />
        <SlashMenu
          open={slashOpen}
          onClose={closeSlash}
          anchorRef={cardRef}
          listId={slashListId}
          items={matches}
          activeIndex={active}
          onActiveChange={setActiveIndex}
          onChoose={(i) => chooseSlash(i, false)}
          emptyHint={slashHint}
          width={Math.min(cardRef.current?.offsetWidth ?? SLASH_MENU_MAX_W, SLASH_MENU_MAX_W)}
          homeDir={homeDir}
        />
        <textarea
          ref={taRef}
          className="hc-composer__textarea"
          rows={size === 'lg' ? 2 : 1}
          value={text}
          placeholder={placeholder}
          aria-label="메시지"
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          aria-controls={slashOpen && matches.length > 0 ? slashListId : undefined}
          aria-activedescendant={slashOpen && matches.length > 0 ? slashOptionId(slashListId, active) : undefined}
          onKeyDown={onKeyDown}
          onPaste={attachments.onPaste}
        />
        <div className="hc-composer__bar">
          <button
            ref={plusRef}
            type="button"
            className="hc-composer__plus"
            aria-label="추가"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            title="파일 첨부 · 폴더 변경"
            onClick={() => setPlusOpen((v) => !v)}
          >
            <PlusIcon width={16} height={16} />
          </button>
          <Menu
            open={plusOpen}
            onClose={() => setPlusOpen(false)}
            anchorRef={plusRef}
            sections={plusSections}
            label="추가"
            placement="top-start"
            width={COMPOSER_MENU_WIDTH}
          />
          {leading}
          <div className="hc-composer__spacer" />
          {trailing}
          {running && onInterrupt ? (
            <button type="button" className="hc-send hc-send--stop" aria-label="정지" title="정지" onClick={onInterrupt}>
              <StopIcon width={12} height={12} />
            </button>
          ) : (
            <button
              type="button"
              className={`hc-send${hasText ? ' hc-send--ready' : ''}`}
              aria-label="보내기"
              title="보내기 (⏎)"
              disabled={!canSend}
              onClick={() => submit()}
            >
              {busy ? <SpinnerIcon width={14} height={14} /> : <span className="hc-send__heart" aria-hidden />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
