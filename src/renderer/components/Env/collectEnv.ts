// Pure summaries of a thread's chat items for the environment popover: subagents it ran and files it touched.
import type { ChatItem, ToolItem } from '../../../shared/types';

export type SubagentStatus = 'running' | 'done' | 'failed';

export interface SubagentInfo {
  toolUseId: string;
  /** `subagent_type` (e.g. "general-purpose"); null when the call did not name one. */
  agentType: string | null;
  description: string | null;
  status: SubagentStatus;
}

const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

function statusOf(item: ToolItem): SubagentStatus {
  if (item.result === undefined) return 'running';
  return item.isError ? 'failed' : 'done';
}

/** Subagent calls (`Task` / `Agent` tool_use) in transcript order. */
export function collectSubagents(items: readonly ChatItem[]): SubagentInfo[] {
  const out: SubagentInfo[] = [];
  for (const item of items) {
    if (item.type !== 'tool' || !SUBAGENT_TOOLS.has(item.name)) continue;
    out.push({
      toolUseId: item.toolUseId,
      agentType: str(item.input.subagent_type),
      description: str(item.input.description),
      status: statusOf(item),
    });
  }
  return out;
}

export function countSubagents(list: readonly SubagentInfo[]): Record<SubagentStatus, number> {
  const counts: Record<SubagentStatus, number> = { running: 0, done: 0, failed: 0 };
  for (const s of list) counts[s.status] += 1;
  return counts;
}

export type SourceKind = 'mention' | 'read' | 'edit';

export interface SourceInfo {
  /** Path relative to the thread folder. */
  path: string;
  /** How it was referenced, most recent first. */
  kinds: SourceKind[];
}

const READ_TOOLS: ReadonlySet<string> = new Set(['Read']);
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** `@path` / `@"path with spaces"` mentions in a user message (the composer's attachment format). */
export function mentionsIn(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const raw = (m[1] ?? m[2] ?? '').replace(/[,;:)\]]+$/, '');
    if (raw) out.push(raw);
  }
  return out;
}

/**
 * `path` relative to `cwd` when it lies inside it (absolute paths from tool inputs, `./x`, plain relative
 * mentions); null for anything outside the thread folder (never offered: it cannot be opened from here).
 */
export function relativeToCwd(path: string, cwd: string): string | null {
  const root = cwd.replace(/\/+$/, '');
  let rel: string;
  if (path.startsWith('/')) {
    if (!path.startsWith(`${root}/`)) return null;
    rel = path.slice(root.length + 1);
  } else if (path.startsWith('~')) {
    return null;
  } else {
    rel = path;
  }
  const parts: string[] = [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

function toolPath(item: ToolItem): string | null {
  return str(item.input.file_path) ?? (item.name === 'NotebookEdit' ? str(item.input.notebook_path) : null);
}

/**
 * Files the thread referenced, most recent first: `@` mentions in user messages and the `file_path` of
 * Read / Edit / Write / MultiEdit / NotebookEdit calls. Paths outside `cwd` are skipped.
 */
export function collectSources(items: readonly ChatItem[], cwd: string): SourceInfo[] {
  const byPath = new Map<string, SourceInfo>();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    const refs: { path: string; kind: SourceKind }[] = [];
    if (item.type === 'user') {
      for (const m of mentionsIn(item.text)) refs.push({ path: m, kind: 'mention' });
    } else if (item.type === 'tool' && (READ_TOOLS.has(item.name) || EDIT_TOOLS.has(item.name))) {
      const p = toolPath(item);
      if (p) refs.push({ path: p, kind: READ_TOOLS.has(item.name) ? 'read' : 'edit' });
    }
    for (const ref of refs) {
      const rel = relativeToCwd(ref.path, cwd);
      if (!rel) continue;
      const entry = byPath.get(rel);
      if (!entry) byPath.set(rel, { path: rel, kinds: [ref.kind] });
      else if (!entry.kinds.includes(ref.kind)) entry.kinds.push(ref.kind);
    }
  }
  return [...byPath.values()];
}
