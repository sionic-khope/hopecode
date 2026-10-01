// CodeMirror configuration of the note editor: markdown (GFM) with fenced-code languages, the theme tokens, history,
// search, and slots (compartments) for Live Preview, read-only (while an answer streams) and section tracking.
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder, type KeyBinding } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { livePreview } from './livePreview';
import { sectionTrackerSlot, sectionTracking, targetField } from './noteTarget';

export const livePreviewSlot = new Compartment();
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
  // Fenced code (language-data parsers)
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: 'var(--ansi-magenta)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--ansi-green)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--tp-fill)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--label-tertiary)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--select)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--ansi-bright-blue)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--ansi-bright-cyan)' },
  { tag: [t.definition(t.variableName)], color: 'var(--label)' },
  { tag: t.invalid, color: 'var(--crit-text)' },
]);

const noteTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--label)' },
    '.cm-scroller': { fontFamily: 'var(--font-chat)', fontSize: 'var(--text-chat)', lineHeight: 'var(--lh-chat)', overflow: 'auto' },
    '.cm-content': { padding: '28px 0 40vh', maxWidth: '760px', margin: '0 auto', caretColor: 'var(--select)' },
    '.cm-line': { padding: '0 32px' },
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
}

export function noteExtensions(hooks: NoteEditorHooks, opts: { live: boolean; sectionTracking: boolean }): Extension[] {
  const saveKey: KeyBinding = {
    key: 'Mod-s',
    preventDefault: true,
    run: () => {
      hooks.onSave();
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
    keymap.of([saveKey, ...markdownKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    placeholder('# 제목부터 쓰거나, 오른쪽에서 노트 작성을 요청하세요'),
    noteTheme,
    targetField,
    livePreviewSlot.of(opts.live ? livePreview() : []),
    readOnlySlot.of(readOnly(false)),
    sectionTrackerSlot.of(sectionTracking(opts.sectionTracking)),
    EditorView.contentAttributes.of({ 'aria-label': '노트 편집기', spellcheck: 'false' }),
  ];
}
