// Markdown source of a rendered block (the "MD" copy chips). Pure: no DOM.
// A block is cut out of the original text by its hast position (react-markdown passes `node` with offsets); a table
// without a usable position is rebuilt as a GFM pipe table from its hast tree.
import type { Element, ElementContent } from 'hast';

interface Positioned {
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Source text of a node by its offsets, or null when it has none. Continuation lines lose the container prefix the
 * first line sits after (`> ` of a blockquote, list indentation), so a quoted table copies as a plain table.
 */
export function sliceSource(source: string, node: Positioned | undefined): string | null {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end > source.length || end <= start) return null;
  const text = source.slice(start, end);
  const prefix = source.slice(source.lastIndexOf('\n', start - 1) + 1, start);
  if (prefix === '' || !/^[ \t>]*$/.test(prefix)) return text;
  const bare = prefix.trimEnd();
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.startsWith(prefix) ? line.slice(prefix.length) : bare && line.startsWith(bare) ? line.slice(bare.length) : line))
    .join('\n');
}

/** `|` inside a cell would end it: escaped as `\|` (also inside inline code, which GFM tables allow). */
export function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function childElements(node: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === tag) out.push(child);
    else out.push(...childElements(child, tag));
  }
  return out;
}

function inlineText(nodes: readonly ElementContent[]): string {
  return nodes.map(inlineOf).join('');
}

/** Inline markdown of a cell's content (the common inline marks; anything else keeps its text). */
function inlineOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return '';
  const inner = inlineText(node.children);
  switch (node.tagName) {
    case 'code':
      return `\`${inner}\``;
    case 'strong':
      return `**${inner}**`;
    case 'em':
      return `*${inner}*`;
    case 'del':
      return `~~${inner}~~`;
    case 'a':
      return `[${inner}](${String(node.properties.href ?? '')})`;
    case 'img':
      return `![${String(node.properties.alt ?? '')}](${String(node.properties.src ?? '')})`;
    case 'br':
      return '<br>';
    default:
      return inner;
  }
}

const ALIGN_ROW: Record<string, string> = { left: ':---', center: ':---:', right: '---:' };

/** A hast `<table>` as a GFM pipe table (header row, alignment row from the header cells' `align`, body rows). */
export function tableToGfm(table: Element): string {
  const rows = childElements(table, 'tr').map((tr) =>
    tr.children.filter((c): c is Element => c.type === 'element' && (c.tagName === 'th' || c.tagName === 'td')),
  );
  if (rows.length === 0) return '';
  const header = rows[0]!;
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const cellsOf = (row: Element[]) => Array.from({ length: width }, (_, i) => (row[i] ? escapeCell(inlineText(row[i]!.children).trim()) : ''));
  const align = Array.from({ length: width }, (_, i) => ALIGN_ROW[String(header[i]?.properties.align ?? '')] ?? '---');
  return [line(cellsOf(header)), line(align), ...rows.slice(1).map((r) => line(cellsOf(r)))].join('\n');
}

/** Markdown of a rendered table: its original text when the position is known, else the rebuilt GFM table. */
export function tableSource(source: string, node: Element | undefined): string {
  return sliceSource(source, node) ?? (node ? tableToGfm(node) : '');
}
