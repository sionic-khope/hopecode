import { memo, useState } from 'react';
import type { ToolItem } from '../../../shared/types';
import { Collapse } from '../common';
import { CheckCircleIcon, ChevronIcon, ErrorCircleIcon, SpinnerIcon, iconForTool } from './icons';
import { DiffView } from './DiffView';
import './Chat.css';

export interface ToolCardProps {
  item: ToolItem;
  defaultExpanded?: boolean;
}

/** Best-effort one-line summary of a tool_use input, per tool name. */
function summarize(item: ToolItem): string {
  const { name, input } = item;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  switch (name) {
    case 'Read':
    case 'NotebookEdit':
      return str(input.file_path) ?? str(input.notebook_path) ?? '';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return str(input.file_path) ?? '';
    case 'Bash':
      return str(input.command) ?? '';
    case 'Grep': {
      const pattern = str(input.pattern) ?? '';
      const path = str(input.path);
      return path ? `${pattern}  ·  ${path}` : pattern;
    }
    case 'Glob': {
      const pattern = str(input.pattern) ?? '';
      const path = str(input.path);
      return path ? `${pattern}  ·  ${path}` : pattern;
    }
    case 'WebFetch':
    case 'WebSearch':
      return str(input.url) ?? str(input.query) ?? '';
    case 'Task':
      return str(input.description) ?? str(input.subagent_type) ?? '';
    case 'TodoWrite': {
      const todos = input.todos;
      return Array.isArray(todos) ? `${todos.length} item${todos.length === 1 ? '' : 's'}` : '';
    }
    default: {
      const entries = Object.entries(input).slice(0, 2);
      return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ');
    }
  }
}

/** Collapsible card for one tool_use / tool_result pair. */
export const ToolCard = memo(function ToolCard({ item, defaultExpanded = false }: ToolCardProps) {
  const [open, setOpen] = useState(defaultExpanded);
  const Icon = iconForTool(item.name);
  const running = item.result === undefined;
  const hasError = item.isError === true;
  const summary = summarize(item);
  const hasPatch = Array.isArray(item.patch) && item.patch.length > 0;
  const editFallback =
    !hasPatch && item.name === 'Edit' && typeof item.input.old_string === 'string' && typeof item.input.new_string === 'string';

  return (
    <div className={`hc-tool${open ? ' hc-tool--open' : ''}`}>
      <button
        type="button"
        className="hc-tool__header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hc-tool__icon">
          <Icon width={14} height={14} />
        </span>
        <span className="hc-tool__name">{item.name}</span>
        <span className="hc-tool__summary">{summary}</span>
        <span
          className={`hc-tool__status ${running ? 'hc-tool__status--running' : hasError ? 'hc-tool__status--error' : 'hc-tool__status--ok'}`}
        >
          {running ? (
            <SpinnerIcon width={13} height={13} />
          ) : hasError ? (
            <ErrorCircleIcon width={13} height={13} />
          ) : (
            <CheckCircleIcon width={13} height={13} />
          )}
        </span>
        <span className="hc-tool__chevron">
          <ChevronIcon width={13} height={13} />
        </span>
      </button>
      <Collapse open={open}>
        <div className="hc-tool__body">
          {hasPatch ? <DiffView patch={item.patch} /> : null}
          {editFallback ? (
            <DiffView oldText={item.input.old_string as string} newText={item.input.new_string as string} />
          ) : null}
          {item.result !== undefined ? (
            <pre className={`hc-tool__result${hasError ? ' hc-tool__result--error' : ''}`}>{item.result}</pre>
          ) : null}
        </div>
      </Collapse>
    </div>
  );
});
