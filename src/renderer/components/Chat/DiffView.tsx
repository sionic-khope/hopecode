import type { StructuredPatchHunk } from '../../../shared/types';
import { diffLinesFromHunks, diffLinesFromOldNew, type DiffRenderLine } from './diffLines';
import './Chat.css';

export interface DiffViewProps {
  /** Preferred source: Edit/Write tool_result's structuredPatch. */
  patch?: StructuredPatchHunk[];
  /** Fallback when no patch is available yet (e.g. Edit tool_use input). */
  oldText?: string;
  newText?: string;
}

const MARKER: Record<DiffRenderLine['kind'], string> = {
  add: '+',
  del: '-',
  context: ' ',
  meta: ' ',
};

/** Renders structuredPatch hunks (or a plain old/new fallback) as a +/- gutter diff. */
export function DiffView({ patch, oldText, newText }: DiffViewProps) {
  const lines: DiffRenderLine[] =
    patch && patch.length > 0
      ? diffLinesFromHunks(patch)
      : oldText !== undefined && newText !== undefined
        ? diffLinesFromOldNew(oldText, newText)
        : [];

  if (lines.length === 0) return null;

  return (
    <div className="hc-diff" role="group" aria-label="Diff">
      {lines.map((line, i) => (
        <div key={i} className={`hc-diff__row hc-diff__row--${line.kind}`}>
          <span className="hc-diff__gutter hc-diff__gutter--old">{line.oldLineNo ?? ''}</span>
          <span className="hc-diff__gutter hc-diff__gutter--new">{line.newLineNo ?? ''}</span>
          <span className="hc-diff__marker">{MARKER[line.kind]}</span>
          <span className="hc-diff__text">{line.text.length > 0 ? line.text : ' '}</span>
        </div>
      ))}
    </div>
  );
}
