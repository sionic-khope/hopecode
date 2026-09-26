// Thread -> Markdown for "공유" (file export in main, clipboard copy in the renderer). Pure: no fs, no DOM.
import type { ChatItem, ToolItem } from '../shared/types';

export interface ThreadMarkdownMeta {
  title: string;
  /** Project folder name. */
  project?: string | null;
  /** Heading for the agent's turns (e.g. "Claude Code"). */
  agentName?: string;
  /** Export time (epoch ms); omitted -> no date line. */
  exportedAt?: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** One-line target of a tool call (file, command, pattern, subagent task). */
export function toolTarget(item: Pick<ToolItem, 'name' | 'input'>): string {
  const { name, input } = item;
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return str(input.file_path) ?? '';
    case 'NotebookEdit':
      return str(input.notebook_path) ?? str(input.file_path) ?? '';
    case 'Bash':
      return str(input.command) ?? '';
    case 'Grep':
    case 'Glob':
      return [str(input.pattern), str(input.path)].filter(Boolean).join(' · ');
    case 'WebFetch':
    case 'WebSearch':
      return str(input.url) ?? str(input.query) ?? '';
    case 'Task':
    case 'Agent':
      return [str(input.subagent_type), str(input.description)].filter(Boolean).join(' · ');
    default:
      return '';
  }
}

function toolStatus(item: ToolItem): string {
  if (item.result === undefined) return '실행 중';
  return item.isError ? '실패' : '완료';
}

/** Inline code span that survives backticks inside `text`. */
function inlineCode(text: string): string {
  const oneLine = text.replace(/\s*\n\s*/g, ' ').trim();
  const longest = Math.max(0, ...(oneLine.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  const pad = oneLine.startsWith('`') || oneLine.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${oneLine}${pad}${fence}`;
}

function toolLine(item: ToolItem): string {
  const target = toolTarget(item);
  return `- 도구 **${item.name}**${target ? ` ${inlineCode(target)}` : ''} (${toolStatus(item)})`;
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l.length > 0 ? `> ${l}` : '>'))
    .join('\n');
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Markdown transcript: title + meta, then one section per turn -- user messages verbatim, agent text verbatim
 * with tool calls as a one-line summary each (name, target, status), notices as quotes. Tool results and
 * diffs are left out.
 */
export function threadToMarkdown(meta: ThreadMarkdownMeta, items: readonly ChatItem[]): string {
  const agent = meta.agentName ?? 'Claude';
  const out: string[] = [`# ${meta.title.replace(/\s*\n\s*/g, ' ').trim() || '스레드'}`];
  const facts = [
    meta.project ? `- 프로젝트: ${meta.project}` : null,
    meta.exportedAt !== undefined ? `- 내보낸 시각: ${isoDate(meta.exportedAt)}` : null,
  ].filter((l): l is string => l !== null);
  if (facts.length > 0) out.push(facts.join('\n'));

  let section: 'user' | 'agent' | null = null;
  for (const item of items) {
    switch (item.type) {
      case 'user':
        out.push('## 사용자', item.text.trim());
        section = 'user';
        break;
      case 'assistant-text':
        if (!item.text.trim()) break;
        if (section !== 'agent') out.push(`## ${agent}`);
        out.push(item.text.trim());
        section = 'agent';
        break;
      case 'tool':
        if (section !== 'agent') out.push(`## ${agent}`);
        out.push(toolLine(item));
        section = 'agent';
        break;
      case 'notice':
        out.push(quote(`${item.level === 'error' ? '오류' : item.level === 'warn' ? '경고' : '알림'}: ${item.text.trim()}`));
        break;
    }
  }
  // Consecutive tool lines form one list.
  return `${out.join('\n\n').replace(/(^- 도구 .*)\n\n(?=- 도구 )/gm, '$1\n')}\n`;
}

/** File name for the save dialog: the title without path / reserved characters, `.md`. */
export function markdownFileName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return `${base || 'thread'}.md`;
}
