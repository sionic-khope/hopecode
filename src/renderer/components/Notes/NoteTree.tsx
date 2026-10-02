import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { NoteChange, NoteEntry } from '../../../shared/notes';
import { baseName, noteNameError, parentOf } from '../../../core/notes/notePaths';
import { invoke } from '../../api';
import { ipcErrorMessage } from '../../errors';

/** IPC error text without the error class / validation prefixes main adds. */
export function noteError(err: unknown): string {
  return ipcErrorMessage(err)
    .replace(/^[A-Za-z]*Error:\s*/, '')
    .replace(/^invalid request for [\w:]+:\s*/, '');
}
import { useNotesStore } from '../../store/notesStore';
import { Button, Menu, Modal, type MenuSection } from '../common';
import { IconChevron, IconFolder, IconFolderPlus, IconMore, IconSearch } from '../Sidebar/icons';
import { IconNotePage } from './icons';
import { useLanguage } from '../../i18n';
import { t } from '../../../shared/i18n';
import { tNodes } from '../../i18n';

/** Loads (or reloads) one folder listing into the store; a folder that is gone is dropped from the cache. */
export async function loadNoteDir(dir: string): Promise<void> {
  try {
    const listing = await invoke('notes:listDir', { dir });
    const s = useNotesStore.getState();
    s.patch({ children: { ...s.children, [dir]: listing.entries } });
  } catch (err) {
    const s = useNotesStore.getState();
    if (dir in s.children) {
      const { [dir]: _gone, ...rest } = s.children;
      s.patch({ children: rest, expanded: s.expanded.filter((d) => d !== dir) });
    }
    if (dir === '') throw err;
  }
}

/** fs watch: reload the cached folders the change touches (all of them for a bulk change). */
export async function refreshNoteDirs(change: NoteChange): Promise<void> {
  const loaded = Object.keys(useNotesStore.getState().children);
  const dirs = change.all
    ? loaded
    : loaded.filter((dir) => change.paths.some((p) => parentOf(p) === dir || p === dir));
  await Promise.all(dirs.map((d) => loadNoteDir(d).catch(() => {})));
}

interface Draft {
  parent: string;
  kind: 'file' | 'dir';
}

function NameInput({
  initial,
  placeholder,
  onSubmit,
  onCancel,
  testId,
}: {
  initial: string;
  placeholder: string;
  onSubmit: (name: string) => Promise<string | null>;
  onCancel: () => void;
  testId: string;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    // Select the name without `.md` so typing replaces it.
    const dot = initial.toLowerCase().endsWith('.md') ? initial.length - 3 : initial.length;
    ref.current?.setSelectionRange(0, dot);
  }, [initial]);
  const submit = async () => {
    const name = value.trim();
    const problem = noteNameError(name);
    if (problem) {
      setError(problem);
      return;
    }
    const failed = await onSubmit(name);
    if (failed) setError(failed);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="hc-notetree__edit">
      <input
        ref={ref}
        className="hc-notetree__input"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={onCancel}
      />
      {error ? (
        <span className="hc-notetree__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface NoteTreeProps {
  vault: string;
  openPath: string | null;
  onOpen: (path: string) => void;
  /** A file or folder was renamed (the open note may need to follow). */
  onRenamed: (from: string, entry: NoteEntry) => void;
  onTrashed: (path: string) => void;
  /** Starts a "새 노트" / "새 폴더" name field from outside (the empty editor's button); once per nonce. */
  draftRequest?: { kind: 'file' | 'dir'; nonce: number } | null;
}

/** The file drawer's body: the vault's folders and `.md` files, loaded one folder at a time; name search; create / rename / trash. */
export const NoteTree = memo(function NoteTree({ vault, openPath, onOpen, onRenamed, onTrashed, draftRequest = null }: NoteTreeProps) {
  useLanguage();
  const children = useNotesStore((s) => s.children);
  const expanded = useNotesStore((s) => s.expanded);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ paths: string[]; truncated: boolean } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<NoteEntry | null>(null);
  const [confirm, setConfirm] = useState<NoteEntry | null>(null);
  const [selectedDir, setSelectedDir] = useState('');
  const menuAnchor = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!vault) return;
    if (!useNotesStore.getState().children['']) {
      loadNoteDir('').catch((err: unknown) => setError(t('noteTree.err.read', { error: noteError(err) })));
    }
  }, [vault]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      invoke('notes:search', { query: q })
        .then(setResults)
        .catch((err: unknown) => setError(noteError(err)));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const toggle = useCallback((dir: string) => {
    const s = useNotesStore.getState();
    setSelectedDir(dir);
    if (s.expanded.includes(dir)) {
      s.patch({ expanded: s.expanded.filter((d) => d !== dir) });
      return;
    }
    s.patch({ expanded: [...s.expanded, dir] });
    if (!s.children[dir]) void loadNoteDir(dir);
  }, []);

  const startDraft = (kind: 'file' | 'dir') => {
    const parent = selectedDir;
    const s = useNotesStore.getState();
    if (parent && !s.expanded.includes(parent)) toggle(parent);
    setQuery('');
    setDraft({ parent, kind });
  };

  const handledDraft = useRef(0);
  useEffect(() => {
    if (!draftRequest || draftRequest.nonce === handledDraft.current) return;
    handledDraft.current = draftRequest.nonce;
    setQuery('');
    setDraft({ parent: selectedDir, kind: draftRequest.kind });
  }, [draftRequest, selectedDir]);

  const create = async (name: string): Promise<string | null> => {
    if (!draft) return null;
    const path = draft.parent ? `${draft.parent}/${name}` : name;
    try {
      const entry = await invoke('notes:create', { path, kind: draft.kind });
      setDraft(null);
      await loadNoteDir(draft.parent);
      if (entry.kind === 'file') onOpen(entry.path);
      else setSelectedDir(entry.path);
      return null;
    } catch (err) {
      return noteError(err);
    }
  };

  const rename = async (entry: NoteEntry, name: string): Promise<string | null> => {
    try {
      const next = await invoke('notes:rename', { path: entry.path, name });
      setRenaming(null);
      await loadNoteDir(parentOf(entry.path));
      onRenamed(entry.path, next);
      return null;
    } catch (err) {
      return noteError(err);
    }
  };

  const trash = async (entry: NoteEntry) => {
    setConfirm(null);
    try {
      await invoke('notes:trash', { path: entry.path });
      await loadNoteDir(parentOf(entry.path));
      onTrashed(entry.path);
    } catch (err) {
      setError(t('noteTree.err.trash', { error: noteError(err) }));
    }
  };

  const openMenu = (entry: NoteEntry, anchor: HTMLElement) => {
    menuAnchor.current = anchor;
    setMenuFor(entry);
  };

  const menuSections: MenuSection[] = menuFor
    ? [
        {
          key: 'entry',
          kind: 'action',
          items: [
            { key: 'rename', label: t('noteTree.rename'), onSelect: () => setRenaming(menuFor.path) },
            { key: 'trash', label: t('noteTree.trash'), tone: 'danger', onSelect: () => setConfirm(menuFor) },
          ],
        },
      ]
    : [];

  const renderRows = (dir: string, depth: number) => {
    const list = children[dir];
    const rows = [];
    if (draft && draft.parent === dir) {
      rows.push(
        <li key="__draft" className="hc-notetree__row hc-notetree__row--edit" style={{ ['--depth' as string]: depth }}>
          <NameInput
            initial=""
            placeholder={draft.kind === 'file' ? t('noteTree.newNoteName') : t('noteTree.newFolderName')}
            testId="note-new-name"
            onSubmit={create}
            onCancel={() => setDraft(null)}
          />
        </li>,
      );
    }
    if (!list) {
      rows.push(
        <li key="__loading" className="hc-notetree__row hc-notetree__row--muted" style={{ ['--depth' as string]: depth }}>
          {t('common.loading')}
        </li>,
      );
      return rows;
    }
    for (const entry of list) {
      const isDir = entry.kind === 'dir';
      const open = isDir && expanded.includes(entry.path);
      const active = entry.path === openPath;
      if (renaming === entry.path) {
        rows.push(
          <li key={entry.path} className="hc-notetree__row hc-notetree__row--edit" style={{ ['--depth' as string]: depth }}>
            <NameInput initial={entry.name} placeholder={t('noteTree.newName')} testId="note-rename" onSubmit={(name) => rename(entry, name)} onCancel={() => setRenaming(null)} />
          </li>,
        );
      } else {
        rows.push(
          <li key={entry.path} role="none">
            <div
              role="treeitem"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              aria-expanded={isDir ? open : undefined}
              className={`hc-notetree__row${active ? ' hc-notetree__row--active' : ''}${isDir && selectedDir === entry.path ? ' hc-notetree__row--dir-selected' : ''}`}
              style={{ ['--depth' as string]: depth }}
              data-testid={isDir ? 'note-dir' : 'note-file'}
              data-path={entry.path}
              onClick={() => (isDir ? toggle(entry.path) : (setSelectedDir(parentOf(entry.path)), onOpen(entry.path)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (isDir) toggle(entry.path);
                  else onOpen(entry.path);
                } else if (e.key === 'F2') {
                  setRenaming(entry.path);
                }
              }}
              onContextMenu={(e: MouseEvent<HTMLDivElement>) => {
                e.preventDefault();
                openMenu(entry, e.currentTarget);
              }}
            >
              {isDir ? (
                <IconChevron className={`hc-notetree__chevron${open ? ' hc-notetree__chevron--open' : ''}`} />
              ) : (
                <span className="hc-notetree__chevron-gap" />
              )}
              {isDir ? <IconFolder className="hc-notetree__icon" /> : <IconNotePage className="hc-notetree__icon" />}
              <span className="hc-notetree__name">{isDir ? entry.name : entry.name.replace(/\.md$/i, '')}</span>
              <button
                type="button"
                className="hc-notetree__more"
                aria-label={t('noteTree.entryMenu', { name: entry.name })}
                onClick={(e) => {
                  e.stopPropagation();
                  openMenu(entry, e.currentTarget);
                }}
              >
                <IconMore />
              </button>
            </div>
          </li>,
        );
      }
      if (open) {
        rows.push(
          <li key={`${entry.path}/__children`} role="none">
            <ul role="group" className="hc-notetree__group">
              {renderRows(entry.path, depth + 1)}
            </ul>
          </li>,
        );
      }
    }
    if (list.length === 0 && !(draft && draft.parent === dir)) {
      rows.push(
        <li key="__empty" className="hc-notetree__row hc-notetree__row--muted" style={{ ['--depth' as string]: depth }}>
          {t('noteTree.empty')}
        </li>,
      );
    }
    return rows;
  };

  return (
    <div className="hc-notetree" data-testid="note-tree">
      <div className="hc-notetree__tools">
        <label className="hc-notetree__search">
          <IconSearch width={14} height={14} />
          <input
            type="search"
            value={query}
            placeholder={t('noteTree.search')}
            aria-label={t('noteTree.search')}
            data-testid="note-search"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Button variant="plain" size="sm" icon aria-label={t('noteTree.newNote')} title={t('noteTree.newNote')} data-testid="note-new-file" onClick={() => startDraft('file')}>
          <IconNotePage width={15} height={15} plus />
        </Button>
        <Button variant="plain" size="sm" icon aria-label={t('noteTree.newFolder')} title={t('noteTree.newFolder')} data-testid="note-new-dir" onClick={() => startDraft('dir')}>
          <IconFolderPlus width={15} height={15} />
        </Button>
      </div>
      {selectedDir ? (
        <div className="hc-notetree__target" title={t('noteTree.target.title')}>
          <span>{t('noteTree.target')}</span> {selectedDir}
          <button type="button" className="hc-notetree__target-clear" aria-label={t('noteTree.target.clear')} onClick={() => setSelectedDir('')}>
            ×
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="hc-notetree__notice" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      ) : null}
      {results ? (
        <ul className="hc-notetree__list" aria-label={t('noteTree.results')} data-testid="note-search-results">
          {results.paths.map((p) => (
            <li key={p}>
              <button type="button" className={`hc-notetree__result${p === openPath ? ' hc-notetree__row--active' : ''}`} onClick={() => onOpen(p)}>
                <IconNotePage className="hc-notetree__icon" />
                <span className="hc-notetree__name">{baseName(p).replace(/\.md$/i, '')}</span>
                <span className="hc-notetree__dir">{parentOf(p)}</span>
              </button>
            </li>
          ))}
          {results.paths.length === 0 ? <li className="hc-notetree__row hc-notetree__row--muted">{t('noteQuick.noMatch')}</li> : null}
          {results.truncated ? <li className="hc-notetree__row hc-notetree__row--muted">{t('noteTree.truncated')}</li> : null}
        </ul>
      ) : (
        <ul className="hc-notetree__list" role="tree" aria-label={t('noteDrawer.aria')}>
          {renderRows('', 0)}
        </ul>
      )}
      <Menu
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        anchorRef={menuAnchor}
        sections={menuSections}
        label={t('noteTree.menu')}
        placement="bottom-start"
        width={200}
      />
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t('noteTree.trash.confirm')}
        role="alertdialog"
        width={420}
        actions={
          <>
            <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" data-testid="note-trash-confirm" onClick={() => confirm && void trash(confirm)}>
              {t('noteTree.trash')}
            </Button>
          </>
        }
      >
        <p className="hc-notetree__confirm">
          {tNodes(confirm?.kind === 'dir' ? 'noteTree.trash.dirBody' : 'noteTree.trash.noteBody', { path: <strong>{confirm?.path}</strong> })}
        </p>
      </Modal>
    </div>
  );
});
