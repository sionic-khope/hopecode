import { useMemo, useState } from 'react';
import type { StructuredPatchHunk } from '../../../shared/types';
import {
  diffRowsFromHunks,
  diffRowsFromOldNew,
  foldContext,
  limitEntries,
  type DiffEntry,
  type DiffRenderLine,
  type DiffRow,
  type WordRange,
} from './diffLines';
import { MoreButton } from './MoreButton';
import { t } from '../../../shared/i18n';
import './Chat.css';

export interface DiffViewProps {
  /** Preferred source: Edit/Write tool_result's structuredPatch. */
  patch?: StructuredPatchHunk[];
  /** Fallback when no patch is available yet (e.g. Edit tool_use input). */
  oldText?: string;
  newText?: string;
}

/** Line rows shown before "N줄 더 보기". */
export const DIFF_PREVIEW_LINES = 40;

const MARKER: Record<DiffRenderLine['kind'], string> = {
  add: '+',
  del: '−',
  context: ' ',
  meta: ' ',
};

/** Soft wrap is a reading preference: the last choice applies to every diff opened afterwards this session. */
let wrapPreference = false;

function LineText({ text, word }: { text: string; word: WordRange | null }) {
  if (text.length === 0) return <span className="hc-diff__text"> </span>;
  if (!word) return <span className="hc-diff__text">{text}</span>;
  return (
    <span className="hc-diff__text">
      {text.slice(0, word[0])}
      <mark className="hc-diff__word">{text.slice(word[0], word[1])}</mark>
      {text.slice(word[1])}
    </span>
  );
}

function Entry({ entry, onUnfold }: { entry: DiffEntry; onUnfold: (id: number) => void }) {
  if (entry.kind === 'hunk') {
    return (
      <div className="hc-diff__hunk">
        <span className="hc-diff__hunk-label">{entry.label}</span>
      </div>
    );
  }
  if (entry.kind === 'fold') {
    const n = entry.hidden.length;
    return (
      <button type="button" className="hc-diff__fold" aria-label={t('diff.unfold', { count: n })} onClick={() => onUnfold(entry.id)}>
        <span className="hc-diff__fold-label">⋯ {t('diff.unchanged', { count: n })}</span>
      </button>
    );
  }
  const { line, word } = entry;
  return (
    <div className={`hc-diff__row hc-diff__row--${line.kind}`}>
      <span className="hc-diff__gutter">
        <span className="hc-diff__ln">{line.oldLineNo ?? ''}</span>
        <span className="hc-diff__ln">{line.newLineNo ?? ''}</span>
        <span className="hc-diff__marker" aria-hidden={line.kind === 'context' || line.kind === 'meta'}>
          {MARKER[line.kind]}
        </span>
      </span>
      <LineText text={line.text} word={word} />
    </div>
  );
}

/**
 * Renders structuredPatch hunks (or a plain old/new fallback) as a +/− gutter diff. Long lines scroll sideways with
 * the gutter pinned (or soft-wrap from the bar's toggle), long unchanged runs fold behind an expander, and a large
 * diff shows its first DIFF_PREVIEW_LINES lines with "N줄 더 보기".
 */
export function DiffView({ patch, oldText, newText }: DiffViewProps) {
  const rows: DiffRow[] = useMemo(
    () =>
      patch && patch.length > 0
        ? diffRowsFromHunks(patch)
        : oldText !== undefined && newText !== undefined
          ? diffRowsFromOldNew(oldText, newText)
          : [],
    [patch, oldText, newText],
  );
  const [wrap, setWrap] = useState(wrapPreference);
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set());
  const [all, setAll] = useState(false);

  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    let maxNo = 0;
    let old = false;
    for (const r of rows) {
      if (r.kind !== 'line') continue;
      if (r.line.kind === 'add') add++;
      else if (r.line.kind === 'del') del++;
      if (r.line.oldLineNo !== null) old = true;
      maxNo = Math.max(maxNo, r.line.oldLineNo ?? 0, r.line.newLineNo ?? 0);
    }
    return { add, del, old, digits: Math.max(2, String(maxNo).length) };
  }, [rows]);
  const entries = useMemo(() => foldContext(rows, unfolded), [rows, unfolded]);
  const { shown, rest } = useMemo(() => limitEntries(entries, all ? null : DIFF_PREVIEW_LINES), [entries, all]);

  if (rows.length === 0) return null;

  const toggleWrap = () => {
    wrapPreference = !wrap;
    setWrap(!wrap);
  };
  const unfold = (id: number) => setUnfolded((prev) => new Set(prev).add(id));

  return (
    <div
      // A new file has no old line numbers: its gutter drops that column.
      className={`hc-diff${wrap ? ' hc-diff--wrap' : ''}${stats.old ? '' : ' hc-diff--new-file'}`}
      role="group"
      aria-label="Diff"
      style={{ ['--diff-digits' as string]: stats.digits }}
    >
      <div className="hc-diff__bar">
        <span className="hc-diff__stat">
          {stats.add > 0 ? <span className="hc-diff__stat-add">+{stats.add}</span> : null}
          {stats.del > 0 ? <span className="hc-diff__stat-del">−{stats.del}</span> : null}
        </span>
        <button type="button" className="hc-diff__tool" aria-pressed={wrap} onClick={toggleWrap} title={t('diff.wrap.title')}>
          {t('diff.wrap')}
        </button>
      </div>
      <div className="hc-diff__scroll" data-testid="diff-scroll">
        <div className="hc-diff__lines">
          {shown.map((entry, i) => (
            <Entry key={entry.kind === 'fold' ? `fold:${entry.id}` : i} entry={entry} onUnfold={unfold} />
          ))}
        </div>
      </div>
      {rest > 0 ? <MoreButton count={rest} onClick={() => setAll(true)} className="hc-diff__more" /> : null}
    </div>
  );
}
