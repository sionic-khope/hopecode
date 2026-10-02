// CodeMirror configuration of the note editor: markdown (GFM) with fenced-code languages, Live Preview (always on),
// the theme tokens, history, search, the AI range marker, ⌘I for the inline prompt and a read-only slot (while an
// inline answer streams).
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder, type KeyBinding } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { livePreview } from './livePreview';
import { targetField } from './noteTarget';

export const readOnlySlot = new Compartment();

export function readOnly(on: boolean): Extension {
  return [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
}

/** Colors come from the app tokens (CSS variables), so a theme overlay recolors the editor too. */
const noteHighlight = HighlightStyle.define([
  { tag: t.heading, fontFamily: 'var(--font-display)', fontWeight: '700', color: 'var(--label)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--label)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--label-secondary)' },
  { tag: t.link, color: 'var(--accent-text)' },
  { tag: t.url, color: 'var(--label-tertiary)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--cyan)' },
  { tag: t.quote, color: 'var(--label-secondary)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--label-tertiary)' },
  { tag: t.list, color: 'var(--label)' },
  // Fenced code (language-data parsers): the --syn-* palette the conversation's code blocks use.
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: [t.operator, t.punctuation], color: 'var(--syn-punct)' },
  { tag: [t.definition(t.variableName)], color: 'var(--label)' },
  { tag: t.invalid, color: 'var(--crit-text)' },
]);

const noteTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--label)' },
    '.cm-scroller': { fontFamily: 'var(--font-chat)', fontSize: 'var(--text-chat)', lineHeight: 'var(--lh-chat)', overflow: 'auto' },
    '.cm-content': { padding: '36px 0 40vh', maxWidth: '720px', margin: '0 auto', caretColor: 'var(--select)' },
    '.cm-line': { padding: '0 40px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--select)', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--selection-text) !important',
    },
    '.cm-placeholder': { color: 'var(--label-tertiary)' },
    '.cm-panels': { backgroundColor: 'var(--bg-card-muted)', color: 'var(--label)' },
  },
  { dark: true },
);

export interface NoteEditorHooks {
  onSave: () => void;
  /** ⌘I: the inline prompt over the selection (or at the caret). */
  onInlinePrompt: () => void;
}

export function noteExtensions(hooks: NoteEditorHooks): Extension[] {
  const saveKey: KeyBinding = {
    key: 'Mod-s',
    preventDefault: true,
    run: () => {
      hooks.onSave();
      return true;
    },
  };
  // ⌘K is the app's command palette (a menu accelerator), so the editor's own prompt key is ⌘I.
  const inlineKey: KeyBinding = {
    key: 'Mod-i',
    preventDefault: true,
    run: () => {
      hooks.onInlinePrompt();
      return true;
    },
  };
  return [
    history(),
    drawSelection(),
    indentOnInput(),
    EditorView.lineWrapping,
    highlightSelectionMatches(),
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
    syntaxHighlighting(noteHighlight),
    keymap.of([saveKey, inlineKey, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    placeholder('# 제목부터 쓰거나, 오른쪽 대화에서 노트를 부탁하세요'),
    noteTheme,
    targetField,
    livePreview(),
    readOnlySlot.of(readOnly(false)),
    EditorView.contentAttributes.of({ 'aria-label': '노트 편집기', spellcheck: 'false' }),
  ];
}
