import { DEFAULT_THREAD_TITLE, THREAD_TITLE_MAX_CHARS } from '../shared/constants';

/**
 * Auto title from the first user message: its first non-blank line, whitespace collapsed, cut to
 * `max` characters (code points, so Hangul / emoji are never split) with a trailing ellipsis.
 */
export function deriveThreadTitle(text: string, max: number = THREAD_TITLE_MAX_CHARS): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => l.length > 0);
  if (!line) return DEFAULT_THREAD_TITLE;
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  return `${chars.slice(0, max).join('').trimEnd()}…`;
}
