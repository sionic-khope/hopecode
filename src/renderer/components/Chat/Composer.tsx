import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../common';
import { SendIcon, StopIcon } from './icons';
import { isSubmitKey } from './composerKeys';
import './Chat.css';

export interface ComposerProps {
  onSend: (text: string) => void;
  onInterrupt: () => void;
  /** Thread is currently running a turn (shows Stop instead of Send). */
  running: boolean;
  /** Disables the textarea + send (e.g. status === 'waiting' or no accounts). */
  disabled?: boolean;
  placeholder?: string;
}

const MAX_HEIGHT_PX = 220;

/** ⏎ sends, ⇧⏎ inserts a newline, Stop replaces Send while a turn is running. */
export const Composer = memo(function Composer({
  onSend,
  onInterrupt,
  running,
  disabled = false,
  placeholder = 'Message…',
}: ComposerProps) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSubmitKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return;
    e.preventDefault();
    submit();
  };

  return (
    <div className="hc-composer">
      <div className="hc-composer__inner">
        <textarea
          ref={taRef}
          className="hc-composer__textarea"
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <Button variant="secondary" size="sm" icon className="hc-composer__send" aria-label="Stop" onClick={onInterrupt}>
            <StopIcon width={12} height={12} />
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon
            className="hc-composer__send"
            aria-label="Send"
            disabled={disabled || text.trim().length === 0}
            onClick={submit}
          >
            <SendIcon width={13} height={13} />
          </Button>
        )}
      </div>
      <div className="hc-composer__hint">⏎ to send · ⇧⏎ for a new line</div>
    </div>
  );
});
