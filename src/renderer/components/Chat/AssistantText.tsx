import { isValidElement, memo, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton';
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

/** Fenced code block: language label + copy button over the code. */
function CodeBlock({ node: _node, children, ...props }: HTMLAttributes<HTMLPreElement> & { node?: unknown }) {
  const code = textOf(children).replace(/\n$/, '');
  const lang = languageOf(children);
  return (
    <div className="hc-code">
      <div className="hc-code__bar">
        <span className="hc-code__lang">{lang ?? 'text'}</span>
        <CopyButton text={code} label="코드 복사" className="hc-code__copy" />
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

// Module-level constants so memoized renders pass react-markdown stable props.
const MARKDOWN_COMPONENTS: Components = { a: ExternalLink, pre: CodeBlock };
const REMARK_PLUGINS = [remarkGfm];

/** Assistant turn body: GFM markdown, no background. Memoized so only the streaming item re-parses while
 *  text-deltas arrive (M9). */
export const AssistantText = memo(function AssistantText({ text, streaming = false }: AssistantTextProps) {
  return (
    <div className={`hc-msg-assistant${streaming ? ' hc-msg-assistant--streaming' : ''}`}>
      <div className="hc-md">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {text}
        </Markdown>
      </div>
      {streaming ? <span className="hc-cursor" aria-hidden /> : null}
    </div>
  );
});
