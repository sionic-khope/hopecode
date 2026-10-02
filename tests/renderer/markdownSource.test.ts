import { describe, expect, it } from 'vitest';
import type { Element, Root } from 'hast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { escapeCell, sliceSource, tableSource, tableToGfm } from '../../src/renderer/components/Chat/markdownSource';

/** The hast tables react-markdown hands its `table` component (same parser chain). */
function tablesOf(markdown: string): Element[] {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
  const tree = processor.runSync(processor.parse(markdown)) as Root;
  const out: Element[] = [];
  const walk = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.tagName === 'table') out.push(child);
      else walk(child);
    }
  };
  walk(tree);
  return out;
}

function withoutPosition(node: Element): Element {
  return JSON.parse(JSON.stringify(node, (key, value) => (key === 'position' ? undefined : value))) as Element;
}

const TABLE = ['| 방식 | 장점 | 단점 |', '| :--- | :---: | ---: |', '| `a\\|b` | **빠릅니다** | [문서](https://x.dev) |', '| lock | 단순 | 느림 |'].join('\n');
const DOC = `표로 비교합니다.\n\n${TABLE}\n\n### 정리\n\n- 끝입니다.`;

describe('markdownSource', () => {
  it('a table copies its original text by offset (alignment row and escapes untouched)', () => {
    const [table] = tablesOf(DOC);
    expect(sliceSource(DOC, table)).toBe(TABLE);
    expect(tableSource(DOC, table)).toBe(TABLE);
  });

  it('a table inside a blockquote drops the `> ` prefix of its continuation lines', () => {
    const quoted = `> ${TABLE.split('\n').join('\n> ')}`;
    const [table] = tablesOf(quoted);
    expect(tableSource(quoted, table)).toBe(TABLE);
  });

  it('without a position the table is rebuilt as GFM: alignment, inline marks, escaped pipes', () => {
    const [table] = tablesOf(DOC);
    const bare = withoutPosition(table!);
    expect(sliceSource(DOC, bare)).toBeNull();
    expect(tableSource(DOC, bare)).toBe(
      ['| 방식 | 장점 | 단점 |', '| :--- | :---: | ---: |', '| `a\\|b` | **빠릅니다** | [문서](https://x.dev) |', '| lock | 단순 | 느림 |'].join('\n'),
    );
  });

  it('rebuild: no alignment is `---`, short rows are padded, a text pipe is escaped', () => {
    const [table] = tablesOf('| a | b |\n| --- | --- |\n| x \\| y |\n');
    expect(tableToGfm(withoutPosition(table!))).toBe('| a | b |\n| --- | --- |\n| x \\| y |  |');
  });

  it('escapeCell escapes pipes and folds newlines', () => {
    expect(escapeCell('a|b\nc')).toBe('a\\|b c');
  });

  it('an out-of-range or missing position is not used', () => {
    expect(sliceSource('abc', { position: { start: { offset: 1 }, end: { offset: 10 } } })).toBeNull();
    expect(sliceSource('abc', undefined)).toBeNull();
    expect(tableSource('abc', undefined)).toBe('');
  });
});
