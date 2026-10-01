// 노트 모드 UI state that outlives the page (switching to a chat and back keeps the open note, the expanded folders
// and the split). Files themselves live on disk; nothing here is persisted.
import { create } from 'zustand';
import type { NoteAgent, NoteEntry } from '../../shared/notes';

/** Editor share of the editor | AI split (0.5 = 반반). */
export const NOTE_SPLIT = { min: 0.3, max: 0.7, initial: 0.5 };

export function clampSplit(v: number): number {
  return Math.min(NOTE_SPLIT.max, Math.max(NOTE_SPLIT.min, Math.round(v * 1000) / 1000));
}

export interface NotesUiState {
  /** Vault the cached tree belongs to. */
  vault: string;
  openPath: string | null;
  /** Expanded folders (vault-relative; '' = root, always loaded). */
  expanded: string[];
  /** Loaded folder listings. */
  children: Record<string, NoteEntry[]>;
  split: number;
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
  split: NOTE_SPLIT.initial,
  agent: 'claude-code',
  claudeModel: null,
  claudeEffort: null,
  codexModel: null,
  codexEffort: null,
  patch: (p) => set(p),
  resetVault: (vault) => set({ vault, openPath: null, expanded: [], children: {} }),
}));
