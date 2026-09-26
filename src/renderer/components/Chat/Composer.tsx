import { memo, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Menu, type MenuSection } from '../common';
import { COMPOSER_MENU_WIDTH } from './ComposerControls';
import { ArrowUpIcon, FolderOpenIcon, PaperclipIcon, PlusIcon, SpinnerIcon, StopIcon } from './icons';
import { isSubmitKey } from './composerKeys';
import type { ChatImage } from '../../../shared/types';
import { ComposerImageTray, useComposerImages } from '../Images/ComposerImages';
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
}

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
}: ComposerProps) {
  const [text, setText] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);

  const replaceText = (next: string) => {
    setText(next);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };

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

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || busy) return;
    const images = attachments.images;
    void Promise.resolve(images.length > 0 ? onSend(trimmed, images) : onSend(trimmed)).then((taken) => {
      if (!taken) return;
      setText('');
      if (images.length > 0) attachments.clear();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
        className={`hc-composer__card${disabled ? ' hc-composer__card--disabled' : ''}${attachments.dragging ? ' hc-composer__card--dragging' : ''}`}
        {...attachments.dropProps}
      >
        <ComposerImageTray images={attachments.images} error={attachments.error} onRemove={attachments.remove} />
        <textarea
          ref={taRef}
          className="hc-composer__textarea"
          rows={size === 'lg' ? 2 : 1}
          value={text}
          placeholder={placeholder}
          aria-label="메시지"
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
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
              onClick={submit}
            >
              {busy ? <SpinnerIcon width={14} height={14} /> : <ArrowUpIcon width={16} height={16} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
