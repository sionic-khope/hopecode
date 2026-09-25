import { memo, type AnchorHTMLAttributes } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

// Module-level constants so memoized renders pass react-markdown stable props.
const MARKDOWN_COMPONENTS: Components = { a: ExternalLink };
const REMARK_PLUGINS = [remarkGfm];

/** Assistant turn body: GFM markdown, no background (plan: "assistant는 배경 없는 본문"). Memoized so only the
 *  streaming item re-parses while text-deltas arrive (M9). */
export const AssistantText = memo(function AssistantText({ text, streaming = false }: AssistantTextProps) {
  return (
    <div className="hc-msg-assistant">
      <div className="hc-md">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {text}
        </Markdown>
      </div>
      {streaming ? <span className="hc-cursor" aria-hidden /> : null}
    </div>
  );
});
