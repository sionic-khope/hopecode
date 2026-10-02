import { useEffect, useRef, useState } from 'react';
import { copyText } from '../../clipboard';
import { playSfx } from '../../sound/engine';
import { GlyphCheck, GlyphCopy } from '../common/glyphs';
import { t } from '../../../shared/i18n';

/**
 * Small square "MD" chip in a block's top-right corner: copies the block's markdown source (read at click time, so a
 * streaming block copies what is on screen), then shows "복사됨" for a moment.
 */
export function MarkdownCopyChip({ getText, label, className }: { getText: () => string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={['hc-mdchip', copied ? 'hc-mdchip--done' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-label={copied ? t('common.copied') : label}
      title={copied ? t('common.copied') : label}
      onClick={() => {
        const text = getText();
        if (text === '') return;
        void copyText(text).then((ok) => {
          if (!ok) return;
          playSfx('select');
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <GlyphCheck width={11} height={11} /> : <GlyphCopy width={11} height={11} />}
      <span>{copied ? t('common.copied') : 'MD'}</span>
    </button>
  );
}
