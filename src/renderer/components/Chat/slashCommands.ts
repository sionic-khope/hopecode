// Pure logic behind the composer's `/` picker: which token the caret is in, ranking, what a choice does.
import { searchPalette } from '../Palette/paletteSearch';
import type { AcpCommandLite, SlashCommandInfo, SlashCommandSource } from '../../../shared/types';
import { t } from '../../../shared/i18n';

/** One picker row, whichever agent it came from. */
export interface SlashItem {
  /** Full command name the agent receives (`oh-my-claudecode:ultragoal`). */
  name: string;
  /** What the picker shows and the composer gets (`ultragoal`); the full name when the short one is ambiguous. */
  label: string;
  description: string;
  /** null = takes no arguments (Enter sends it right away). */
  argumentHint: string | null;
  source: SlashCommandSource;
  /** Badge text: `user`, `project`, `plugin:xxx`, `<agent> 내장`, `session`. */
  badge: string;
  path?: string;
  preview?: string;
}

/** `/query` the caret is in: a slash at the start of the input or of a line, no whitespace up to the caret. */
export interface SlashToken {
  /** Index of the slash. */
  start: number;
  /** End of the token (first whitespace after the caret, or the end of the text). */
  end: number;
  /** Text between the slash and the caret. */
  query: string;
  /** The slash is the first character of the input (the only place the agents dispatch a command). */
  atInputStart: boolean;
}

export const SLASH_RESULT_LIMIT = 60;

export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const at = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  if (text[lineStart] !== '/' || at <= lineStart) return null;
  const query = text.slice(lineStart + 1, at);
  if (/\s/.test(query)) return null;
  const rest = /\s/.exec(text.slice(at));
  return { start: lineStart, end: rest ? at + rest.index : text.length, query, atInputStart: lineStart === 0 };
}

/** Fuzzy ranking (the ⌘K palette's): name prefix > word start > substring > description > subsequence. */
export function filterSlashCommands(items: readonly SlashItem[], query: string, limit = SLASH_RESULT_LIMIT): SlashItem[] {
  const rows = items.map((item, i) => ({
    id: String(i),
    title: item.label,
    subtitle: item.label === item.name ? item.description : `${item.name} ${item.description}`,
    group: item.source,
    item,
  }));
  return searchPalette(rows, query, limit).map((m) => m.item.item);
}

/** `/label args` -> `/name args` for a shortened plugin command, so the agent always gets the namespaced name. */
export function expandSlashLabel(text: string, items: readonly SlashItem[]): string {
  const m = /^\/(\S+)/.exec(text);
  if (!m) return text;
  const item = items.find((i) => i.label === m[1] && i.label !== i.name);
  return item ? `/${item.name}${text.slice(m[0].length)}` : text;
}

/** Replaces the token with `/name ` and puts the caret after the space. */
export function applySlashChoice(text: string, token: SlashToken, name: string): { text: string; caret: number } {
  const insert = `/${name} `;
  const after = text.slice(token.end).replace(/^ /, '');
  return { text: `${text.slice(0, token.start)}${insert}${after}`, caret: token.start + insert.length };
}

/**
 * Enter on a row sends `/name` at once when the command takes no arguments and it would be the whole message
 * (Claude Code runs an argument-less command on Enter; one with an argument hint is completed for typing).
 */
export function sendsOnEnter(item: SlashItem, text: string, token: SlashToken): boolean {
  return item.argumentHint === null && token.atInputStart && text.slice(token.end).trim() === '';
}

export function claudeBadge(c: Pick<SlashCommandInfo, 'source' | 'plugin'>): string {
  if (c.source === 'plugin') return c.plugin ?? 'plugin';
  if (c.source === 'builtin') return t('slash.builtin', { agent: 'Claude' });
  return c.source;
}

/** `plugin:skill` -> `skill` unless another command has that name or short form. */
function shortLabels(names: readonly string[]): Map<string, string> {
  const short = (n: string) => n.slice(n.lastIndexOf(':') + 1);
  const count = new Map<string, number>();
  for (const n of names) for (const k of new Set([n, short(n)])) count.set(k, (count.get(k) ?? 0) + 1);
  return new Map(names.map((n) => [n, n.includes(':') && count.get(short(n)) === 1 ? short(n) : n]));
}

export function fromClaude(commands: readonly SlashCommandInfo[]): SlashItem[] {
  const labels = shortLabels(commands.map((c) => c.name));
  return commands.map((c) => ({
    name: c.name,
    label: labels.get(c.name) ?? c.name,
    description: c.description,
    argumentHint: c.argumentHint,
    source: c.source,
    badge: claudeBadge(c),
    ...(c.path ? { path: c.path } : {}),
    ...(c.preview ? { preview: c.preview } : {}),
  }));
}

/** ACP `available_commands_update` rows; `agentName` labels the badge (`Codex 내장`). */
export function fromAcp(commands: readonly AcpCommandLite[], agentName: string): SlashItem[] {
  return commands.map((c) => ({
    name: c.name,
    label: c.name,
    description: c.description,
    argumentHint: c.hint,
    source: 'builtin',
    badge: t('slash.builtin', { agent: agentName }),
  }));
}
