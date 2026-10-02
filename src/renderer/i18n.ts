// Renderer side of shared/i18n. Strings come from the shared `t()` (its language is switched by the store before
// React re-renders); a component calls `useLanguage()` so a switch re-renders it, and puts the returned language in
// the deps of any memo that builds text.
import { Fragment, createElement, type ReactNode } from 'react';
import { t, type Language, type MessageKey, type MessageParams } from '../shared/i18n';
import { useAppStore } from './store';

/** The current UI language; subscribes the calling component to language switches. */
export function useLanguage(): Language {
  return useAppStore((s) => s.language);
}

/**
 * A message with React nodes in some placeholders (`{project}` -> a styled span), so each language keeps its own word
 * order around them. Plain `params` are filled first; placeholders named in `nodes` become those nodes.
 */
export function tNodes(key: MessageKey, nodes: Record<string, ReactNode>, params?: MessageParams): ReactNode[] {
  return t(key, params)
    .split(/(\{\w+\})/)
    .filter((part) => part !== '')
    .map((part, i) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      return createElement(Fragment, { key: i }, name !== undefined && name in nodes ? nodes[name] : part);
    });
}
