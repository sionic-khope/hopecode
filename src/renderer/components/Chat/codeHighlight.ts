// Syntax colours for fenced code in the conversation: the fence's language is looked up in @codemirror/language-data
// (the note editor's set, loaded on demand), parsed with its Lezer parser and split into `tok-*` classed runs
// (classHighlighter). Colours live in CSS (--syn-* tokens), so a theme overlay recolours chat and notes alike.
import { useEffect, useMemo, useReducer } from 'react';
import { LanguageDescription, type Language } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightCode } from '@lezer/highlight';

export interface CodeToken {
  text: string;
  /** Space-separated `tok-*` classes; '' for plain text. */
  cls: string;
}

/** Above this size highlighting is skipped (the block still renders, uncoloured). */
const MAX_HIGHLIGHT_CHARS = 60_000;

export function findLanguage(name: string | null): LanguageDescription | null {
  if (!name) return null;
  return LanguageDescription.matchLanguageName(languages, name, false) ?? null;
}

/** Coloured runs of `code`; null when the parser fails (plain text then). */
export function highlightTokens(code: string, language: Language): CodeToken[] | null {
  try {
    const tree = language.parser.parse(code);
    const out: CodeToken[] = [];
    highlightCode(
      code,
      tree,
      classHighlighter,
      (text, cls) => out.push({ text, cls }),
      () => out.push({ text: '\n', cls: '' }),
    );
    return out;
  } catch {
    return null;
  }
}

/**
 * Tokens of `code` in language `lang`, or null until the language is loaded (first use of a language loads its
 * parser once; later blocks highlight on their first render, so a streamed block does not flash plain -> coloured).
 */
export function useHighlightedCode(code: string, lang: string | null): CodeToken[] | null {
  const desc = useMemo(() => findLanguage(lang), [lang]);
  const [loaded, markLoaded] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!desc || desc.support) return;
    let alive = true;
    desc.load().then(
      () => alive && markLoaded(),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [desc]);
  return useMemo(() => {
    const support = desc?.support;
    if (!support || code.length > MAX_HIGHLIGHT_CHARS) return null;
    return highlightTokens(code, support.language);
    // `loaded` re-runs this once the parser arrives.
  }, [code, desc, loaded]);
}
