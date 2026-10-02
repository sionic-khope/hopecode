// Obsidian-style Live Preview for CodeMirror 6: markdown syntax marks are hidden and the text styled on every line
// the selection does not touch; the line(s) under the cursor show the raw markdown. Built from the lezer markdown
// tree of the visible ranges only, so long notes stay cheap.
import { type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNodeRef } from '@lezer/common';
import { invoke } from '../../../api';
import { t } from '../../../../shared/i18n';

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-md-bullet';
    el.textContent = '•';
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.className = 'cm-md-task';
    el.checked = this.checked;
    el.setAttribute('aria-label', this.checked ? t('noteEditor.taskDone') : t('noteEditor.task'));
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-md-hr';
    return el;
  }
}

class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  override eq(other: CodeLangWidget): boolean {
    return other.lang === this.lang;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-md-codelang';
    el.textContent = this.lang;
    return el;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const inlineCode = Decoration.mark({ class: 'cm-md-code' });
const lineClass = (cls: string) => Decoration.line({ class: cls });

/** Line numbers (1-based) any selection range touches. */
function activeLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) out.add(n);
  }
  return out;
}

function touches(state: EditorState, active: Set<number>, from: number, to: number): boolean {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  for (let n = first; n <= last; n++) if (active.has(n)) return true;
  return false;
}

/** Hides `[from, to)` plus one following space (heading / quote marks). */
function hideMark(state: EditorState, out: Range<Decoration>[], from: number, to: number, eatSpace: boolean): void {
  const end = eatSpace && state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
  if (end > from) out.push(hide.range(from, end));
}

function eachLine(state: EditorState, from: number, to: number, fn: (lineFrom: number, index: number, count: number) => void): void {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  for (let n = first; n <= last; n++) fn(state.doc.line(n).from, n - first, last - first + 1);
}

export function buildLivePreview(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  const out: Range<Decoration>[] = [];
  const active = activeLines(state);
  const tree = syntaxTree(state);
  const doc = state.doc;

  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node: SyntaxNodeRef) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(lineClass(`cm-md-h cm-md-h${heading[1]}`).range(doc.lineAt(node.from).from));
          if (!touches(state, active, node.from, node.to)) {
            const marks = node.node.getChildren('HeaderMark');
            marks.forEach((m, i) => {
              // Closing `#`s of `## title ##` go together with the space before them.
              if (i === 0) hideMark(state, out, m.from, m.to, true);
              else out.push(hide.range(m.from - (doc.sliceString(m.from - 1, m.from) === ' ' ? 1 : 0), m.to));
            });
          }
          return;
        }
        switch (name) {
          case 'Emphasis':
          case 'StrongEmphasis':
          case 'Strikethrough':
            if (!touches(state, active, node.from, node.to)) {
              for (const m of node.node.getChildren(name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark')) out.push(hide.range(m.from, m.to));
            }
            return;
          case 'InlineCode': {
            const marks = node.node.getChildren('CodeMark');
            const inner = marks.length === 2 ? { from: marks[0].to, to: marks[1].from } : { from: node.from, to: node.to };
            if (inner.to > inner.from) out.push(inlineCode.range(inner.from, inner.to));
            if (!touches(state, active, node.from, node.to)) for (const m of marks) out.push(hide.range(m.from, m.to));
            return false;
          }
          case 'Link': {
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            if (marks.length >= 2) {
              const textFrom = marks[0].to;
              const textTo = marks[1].from;
              if (textTo > textFrom) {
                const href = url ? doc.sliceString(url.from, url.to) : '';
                out.push(Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': href, title: href ? t('noteEditor.linkTitle', { href }) : '' } }).range(textFrom, textTo));
              }
              if (!touches(state, active, node.from, node.to)) {
                out.push(hide.range(node.from, textFrom));
                if (node.to > textTo) out.push(hide.range(textTo, node.to));
              }
            }
            return false;
          }
          case 'Blockquote':
            eachLine(state, node.from, node.to, (lineFrom) => out.push(lineClass('cm-md-quote').range(lineFrom)));
            return;
          case 'QuoteMark':
            if (!touches(state, active, node.from, node.to)) hideMark(state, out, node.from, node.to, true);
            return;
          case 'ListMark': {
            if (touches(state, active, node.from, node.to)) return;
            const mark = doc.sliceString(node.from, node.to);
            const parent = node.node.parent;
            const task = parent?.getChild('Task');
            if (task) {
              // `- [ ] item`: the bullet goes, the checkbox stands in for both.
              hideMark(state, out, node.from, node.to, true);
            } else if (mark === '-' || mark === '*' || mark === '+') {
              out.push(bullet.range(node.from, node.to));
            }
            return;
          }
          case 'TaskMarker': {
            if (touches(state, active, node.from, node.to)) return;
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to));
            return;
          }
          case 'HorizontalRule':
            if (!touches(state, active, node.from, node.to)) out.push(rule.range(node.from, node.to));
            return false;
          case 'FencedCode': {
            const blockActive = touches(state, active, node.from, node.to);
            eachLine(state, node.from, node.to, (lineFrom, i, count) => {
              const edge = i === 0 ? ' cm-md-codeblock-first' : i === count - 1 ? ' cm-md-codeblock-last' : '';
              out.push(lineClass(`cm-md-codeblock${edge}`).range(lineFrom));
            });
            if (!blockActive) {
              const first = doc.lineAt(node.from);
              const last = doc.lineAt(node.to);
              const info = node.node.getChild('CodeInfo');
              const lang = info ? doc.sliceString(info.from, info.to) : '';
              if (first.to > first.from) {
                out.push(
                  (lang ? Decoration.replace({ widget: new CodeLangWidget(lang) }) : hide).range(first.from, first.to),
                );
              }
              if (last.number !== first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text) && last.to > last.from) {
                out.push(hide.range(last.from, last.to));
              }
            }
            return false;
          }
          case 'Table':
            eachLine(state, node.from, node.to, (lineFrom) => out.push(lineClass('cm-md-table').range(lineFrom)));
            return;
          case 'TableDelimiter':
            if (node.node.parent?.name === 'Table') {
              out.push(lineClass('cm-md-table-delim').range(doc.lineAt(node.from).from));
            }
            return;
          default:
            return;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLivePreview(view.state, view.visibleRanges);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildLivePreview(u.state, u.view.visibleRanges);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Checkbox clicks toggle `[ ]` / `[x]` in the text (one undoable change); ⌘-click on a link opens it in the browser. */
const taskToggle = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    const link = target?.closest<HTMLElement>('.cm-md-link');
    if (link && event.metaKey) {
      const href = link.dataset.href;
      event.preventDefault();
      if (href) void invoke('notes:openLink', { url: href }).catch(() => {});
      return true;
    }
    if (!target || !target.classList.contains('cm-md-task')) return false;
    if (view.state.readOnly) return true;
    const pos = view.posAtDOM(target);
    const text = view.state.doc.sliceString(pos, pos + 3);
    if (!/^\[[ xX]\]$/.test(text)) return false;
    event.preventDefault();
    view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: text[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' });
    return true;
  },
});

export function livePreview(): Extension {
  return [livePreviewPlugin, taskToggle];
}
