import { useEffect, useRef, useState } from 'react';
import { copyText } from '../../clipboard';
import { GlyphCheck, GlyphCopy } from '../common/glyphs';
import { t } from '../../../shared/i18n';

/** Icon button that copies `text` and shows a check for a moment. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={['hc-copy', copied ? 'hc-copy--done' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-label={copied ? t('common.copied') : label}
      title={copied ? t('common.copied') : label}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <GlyphCheck width={14} height={14} /> : <GlyphCopy width={14} height={14} />}
    </button>
  );
}
