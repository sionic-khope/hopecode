// 노트 모드: markdown vaults (folders the user registered), their file tree, per-note AI requests.
// Every path the renderer sends is relative to the active vault (posix `/`); main resolves and contains it.
import type { AgentKind } from './types';

/** Agents a note request can run with. */
export type NoteAgent = Extract<AgentKind, 'claude-code' | 'codex'>;

export const NOTE_AGENTS: readonly NoteAgent[] = ['claude-code', 'codex'];

/**
 * `chat`: a conversation turn in the AI pane (free text; note content comes back as `note-*` blocks shown as cards).
 * `inline`: the floating prompt over an editor selection (the answer replaces the selection, or lands at the caret).
 */
export type NoteAiKind = 'chat' | 'inline';

export const NOTE_AI_KINDS: readonly NoteAiKind[] = ['chat', 'inline'];

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
  /**
   * The vault is its own git repository. Before the user turned git on for the vault (`enabled: false`) this comes
   * from file checks only (no git process ran) and `changed` is empty.
   */
  isRepo: boolean;
  /** The user turned git on for this vault (settings.noteGitVaults). */
  enabled: boolean;
  /** Changed `.md` files (vault-relative), untracked included. */
  changed: string[];
}

/** A note card the user put into the editor (or took back out). Kept with the conversation row. */
export interface NoteCardMark {
  state: 'applied' | 'reverted';
  /** Applied: where the text landed and what it replaced, so "되돌리기" can find it again (absent when too large). */
  at?: number;
  inserted?: string;
  original?: string;
}

export interface NoteChatItem {
  id: string;
  role: 'user' | 'assistant';
  /** User rows: the request; assistant rows: the whole answer (cards included) or the error. */
  text: string;
  createdAt: number;
  /** Assistant rows: how the run ended. */
  status?: 'done' | 'stopped' | 'error';
  /** Assistant rows: card index (order in the answer) -> what the user did with it. */
  cards?: Record<string, NoteCardMark>;
}

export interface NoteAiStartRequest {
  requestId: string;
  /** The open note (vault-relative). */
  path: string;
  agent: NoteAgent;
  /** Claude model value / Codex model id; null = default. */
  model: string | null;
  effort: string | null;
  kind: NoteAiKind;
  request: string;
  /** The whole editor text (unsaved edits included). */
  document: string;
  /** inline: the selected range of `document` (from === to: write at the caret). null for chat. */
  selection: { from: number; to: number } | null;
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
