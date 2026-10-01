// 노트 모드: markdown vaults (folders the user registered), their file tree, per-note AI requests.
// Every path the renderer sends is relative to the active vault (posix `/`); main resolves and contains it.
import type { AgentKind } from './types';

/** Agents a note request can run with. */
export type NoteAgent = Extract<AgentKind, 'claude-code' | 'codex'>;

export const NOTE_AGENTS: readonly NoteAgent[] = ['claude-code', 'codex'];

/** 작성 (insert at the caret), 이 섹션 (replace the target range), 전체 수정 (rewrite the whole note). */
export type NoteAiMode = 'write' | 'section' | 'rewrite';

export const NOTE_AI_MODES: readonly NoteAiMode[] = ['write', 'section', 'rewrite'];

export interface NoteEntry {
  /** Last path segment. */
  name: string;
  /** Vault-relative posix path. */
  path: string;
  kind: 'dir' | 'file';
}

export interface NoteDirListing {
  entries: NoteEntry[];
  /** More entries than the listing cap: the rest were left out. */
  truncated: boolean;
}

export interface NoteSearchResult {
  /** Vault-relative paths of `.md` files whose name matches. */
  paths: string[];
  /** The walk stopped at its cap (results may be incomplete). */
  truncated: boolean;
}

export interface NoteFile {
  text: string;
  mtimeMs: number;
}

export interface NoteGitStatus {
  isRepo: boolean;
  /** Changed `.md` files (vault-relative), untracked included. */
  changed: string[];
}

export interface NoteChatItem {
  id: string;
  role: 'user' | 'assistant';
  mode: NoteAiMode;
  text: string;
  createdAt: number;
  /** Assistant rows: how the run ended. */
  status?: 'done' | 'stopped' | 'error';
}

export interface NoteAiStartRequest {
  requestId: string;
  /** The open note (vault-relative). */
  path: string;
  agent: NoteAgent;
  /** Claude model value / Codex model id; null = default. */
  model: string | null;
  effort: string | null;
  mode: NoteAiMode;
  request: string;
  /** The whole editor text (unsaved edits included). */
  document: string;
  /** 이 섹션: the target text; 작성: the text around the caret is not sent separately. */
  target: string | null;
}

export type NoteAiEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'done'; stopped: boolean }
  | { requestId: string; type: 'error'; message: string };

/** Payload of `notes:changed` (fs watch, debounced). */
export interface NoteChange {
  vault: string;
  /** Vault-relative paths that changed (capped; `all: true` = refresh everything). */
  paths: string[];
  all: boolean;
}
