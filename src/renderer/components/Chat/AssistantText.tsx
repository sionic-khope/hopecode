import {
  createContext,
  isValidElement,
  memo,
  useContext,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import type { Element } from 'hast';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton';
import { MarkdownCopyChip } from './MarkdownCopyChip';
import { tableSource } from './markdownSource';
import { MoreButton } from './MoreButton';
import { useHighlightedCode } from './codeHighlight';
import { useLanguage } from '../../i18n';
import { t } from '../../../shared/i18n';
import './Chat.css';

export interface AssistantTextProps {
  text: string;
  /** True while this item is still receiving text-delta events. */
  streaming?: boolean;
}

// Links never navigate the app window: `target=_blank` becomes a window-open request that main hands to
// the external browser.
function ExternalLink({ node: _node, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noreferrer noopener" />;
}

/** Plain text of a rendered markdown subtree (code block contents for the copy button). */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** `language-ts` -> `ts` from the fenced block's <code> class. */
function languageOf(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string }>(child)) return null;
  const m = /language-([\w+#.-]+)/.exec(child.props.className ?? '');
  return m ? m[1]! : null;
}

/** Lines of a fenced block shown before "N줄 더 보기"; blocks up to CODE_PREVIEW_LINES + 6 lines show whole. */
export const CODE_PREVIEW_LINES = 30;

/** Soft wrap of fenced code: the last choice applies to every block rendered afterwards this session. */
let codeWrapPreference = false;

function CodeTokens({ code, lang }: { code: string; lang: string | null }) {
  const tokens = useHighlightedCode(code, lang);
  if (!tokens) return <>{code}</>;
  return (
    <>
      {tokens.map((t, i) => (t.cls ? <span key={i} className={t.cls}>{t.text}</span> : t.text))}
    </>
  );
}

/**
 * Fenced code block: language label, wrap toggle and copy button over the code, syntax colours, sideways scroll for
 * long lines. A long block shows its first CODE_PREVIEW_LINES lines (its height stops growing while it streams in)
 * with "N줄 더 보기" / "접기".
 */
function CodeBlock({ node: _node, children, className: _className, ...props }: HTMLAttributes<HTMLPreElement> & { node?: unknown }) {
  const code = textOf(children).replace(/\n$/, '');
  const lang = languageOf(children);
  const [all, setAll] = useState(false);
  const [wrap, setWrap] = useState(codeWrapPreference);
  const lines = useMemo(() => code.split('\n'), [code]);
  const long = lines.length > CODE_PREVIEW_LINES + 6;
  const shown = long && !all ? lines.slice(0, CODE_PREVIEW_LINES).join('\n') : code;
  const toggleWrap = () => {
    codeWrapPreference = !wrap;
    setWrap(!wrap);
  };
  return (
    <div className={`hc-code${long && !all ? ' hc-code--clipped' : ''}`}>
      <div className="hc-code__bar">
        <span className="hc-code__lang">{lang ?? 'text'}</span>
        <span className="hc-code__count">{t('code.lines', { count: lines.length })}</span>
        <span className="hc-code__spacer" />
        <button type="button" className="hc-diff__tool hc-code__tool" aria-pressed={wrap} onClick={toggleWrap} title={t('diff.wrap.title')}>
          {t('diff.wrap')}
        </button>
        <CopyButton text={code} label={t('code.copy')} className="hc-code__copy" />
      </div>
      <pre {...props} className={wrap ? 'hc-code__pre hc-code__pre--wrap' : 'hc-code__pre'}>
        <code className={lang ? `language-${lang}` : undefined}>
          <CodeTokens code={shown} lang={lang} />
        </code>
      </pre>
      {long ? <MoreButton count={all ? null : lines.length - CODE_PREVIEW_LINES} onClick={() => setAll(!all)} className="hc-code__more" /> : null}
    </div>
  );
}

/** The markdown text being rendered, for blocks that copy their own source. */
const MarkdownSource = createContext('');

/** Table with an "MD" chip in its top-right corner that copies the table's GFM source. */
function TableBlock({ node, ...props }: HTMLAttributes<HTMLTableElement> & { node?: Element }) {
  const source = useContext(MarkdownSource);
  return (
    <div className="hc-mdblock">
      <table {...props} />
      <MarkdownCopyChip getText={() => tableSource(source, node)} label={t('code.copyTable')} className="hc-mdblock__copy" />
    </div>
  );
}

// Module-level constants so memoized renders pass react-markdown stable props.
const MARKDOWN_COMPONENTS: Components = { a: ExternalLink, pre: CodeBlock, table: TableBlock };
const REMARK_PLUGINS = [remarkGfm];

/** Assistant turn body: GFM markdown, no background. Memoized so only the streaming item re-parses while
 *  text-deltas arrive (M9). */
export const AssistantText = memo(function AssistantText({ text, streaming = false }: AssistantTextProps) {
  useLanguage();
  return (
    <div className={`hc-msg-assistant${streaming ? ' hc-msg-assistant--streaming' : ''}`}>
      <div className="hc-md">
        <MarkdownSource.Provider value={text}>
          <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {text}
          </Markdown>
        </MarkdownSource.Provider>
      </div>
      {streaming ? <span className="hc-cursor" aria-hidden /> : null}
    </div>
  );
});
