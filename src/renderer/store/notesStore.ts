// 노트 모드 UI state that outlives the page (switching to a chat and back keeps the open note, the expanded folders
// and the pane layout). Files themselves live on disk; nothing here is persisted.
import { create } from 'zustand';
import type { NoteAgent, NoteAiMode, NoteEntry } from '../../shared/notes';

export type NoteViewMode = 'live' | 'source' | 'preview';

export const NOTE_TREE_W = { min: 180, max: 480, initial: 260 };
export const NOTE_CHAT_W = { min: 300, max: 640, initial: 380 };

export interface NotesUiState {
  /** Vault the cached tree belongs to. */
  vault: string;
  openPath: string | null;
  /** Expanded folders (vault-relative; '' = root, always loaded). */
  expanded: string[];
  /** Loaded folder listings. */
  children: Record<string, NoteEntry[]>;
  treeW: number;
  chatW: number;
  treeOpen: boolean;
  chatOpen: boolean;
  view: NoteViewMode;
  aiMode: NoteAiMode;
  agent: NoteAgent;
  /** null = the settings default of that agent. */
  claudeModel: string | null;
  claudeEffort: string | null;
  codexModel: string | null;
  codexEffort: string | null;
  patch(p: Partial<Omit<NotesUiState, 'patch' | 'resetVault'>>): void;
  /** Another vault became active: the cached tree and the open note belong to the old one. */
  resetVault(vault: string): void;
}

export const useNotesStore = create<NotesUiState>((set) => ({
  vault: '',
  openPath: null,
  expanded: [],
  children: {},
  treeW: NOTE_TREE_W.initial,
  chatW: NOTE_CHAT_W.initial,
  treeOpen: true,
  chatOpen: true,
  view: 'live',
  aiMode: 'write',
  agent: 'claude-code',
  claudeModel: null,
  claudeEffort: null,
  codexModel: null,
  codexEffort: null,
  patch: (p) => set(p),
  resetVault: (vault) => set({ vault, openPath: null, expanded: [], children: {} }),
}));
