import { memo, useEffect, useRef, useState } from 'react';
import type { NoteEntry } from '../../../shared/notes';
import { tildePath } from '../../../core/format';
import { Button, Menu, type MenuSection } from '../common';
import { GlyphClose, GlyphFolderOpen } from '../common/glyphs';
import { IconChevron } from '../Sidebar/icons';
import { NoteTree } from './NoteTree';

export interface NoteFileDrawerProps {
  open: boolean;
  vault: string;
  vaults: readonly string[];
  homeDir: string | null;
  openPath: string | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onRenamed: (from: string, entry: NoteEntry) => void;
  onTrashed: (path: string) => void;
  onSelectVault: (path: string) => void;
  onAddVault: () => void;
  onRemoveVault: () => void;
  draftRequest: { kind: 'file' | 'dir'; nonce: number } | null;
}

/**
 * The notes' file tree as a drawer that slides over the editor from the breadcrumb: vault switch / add / remove,
 * name search, new note / folder, rename and trash. Always mounted (the tree keeps its state); hidden and inert
 * while closed.
 */
export const NoteFileDrawer = memo(function NoteFileDrawer(props: NoteFileDrawerProps) {
  const { open, vault, vaults, homeDir, openPath, onClose } = props;
  const [vaultMenu, setVaultMenu] = useState(false);
  const vaultRef = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Opening puts focus in the drawer (the search box) so the keyboard follows.
  useEffect(() => {
    if (!open) {
      setVaultMenu(false);
      return;
    }
    const t = window.setTimeout(() => {
      const el = panel.current;
      if (el && !el.contains(document.activeElement)) el.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [open]);

  const vaultName = vault.split('/').filter(Boolean).pop() ?? vault;
  const sections: MenuSection[] = [
    {
      key: 'vaults',
      title: '노트 폴더',
      kind: 'radio',
      items: vaults.map((v) => ({
        key: v,
        label: v.split('/').filter(Boolean).pop() ?? v,
        description: tildePath(v, homeDir),
        checked: v === vault,
        onSelect: () => props.onSelectVault(v),
      })),
    },
    {
      key: 'actions',
      kind: 'action',
      items: [
        { key: 'add', label: '다른 폴더 추가…', icon: <GlyphFolderOpen width={15} height={15} />, onSelect: props.onAddVault },
        { key: 'remove', label: '이 폴더 목록에서 빼기', tone: 'danger', description: '파일은 지우지 않습니다', onSelect: props.onRemoveVault },
      ],
    },
  ];

  return (
    <>
      <div className={`hc-notedrawer__scrim${open ? ' hc-notedrawer__scrim--open' : ''}`} aria-hidden onClick={onClose} />
      <div
        ref={panel}
        className={`hc-notedrawer${open ? ' hc-notedrawer--open' : ''}`}
        data-testid="note-drawer"
        role={open ? 'dialog' : undefined}
        aria-label="노트 파일"
        aria-hidden={!open}
        inert={!open}
        onKeyDown={(e) => {
          // Esc closes the drawer unless a field inside handled it (rename / new name inputs cancel themselves).
          if (e.key === 'Escape' && !e.defaultPrevented && !vaultMenu) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="hc-notedrawer__head">
          <button
            ref={vaultRef}
            type="button"
            className="hc-notedrawer__vault"
            aria-haspopup="menu"
            aria-expanded={vaultMenu}
            data-testid="notes-vault"
            title={tildePath(vault, homeDir)}
            onClick={() => setVaultMenu((v) => !v)}
          >
            <GlyphFolderOpen width={14} height={14} />
            <span className="hc-notedrawer__vault-name">{vaultName}</span>
            <IconChevron className="hc-notedrawer__vault-chevron" />
          </button>
          <Menu open={vaultMenu} onClose={() => setVaultMenu(false)} anchorRef={vaultRef} sections={sections} label="노트 폴더" placement="bottom-start" width={300} />
          <span className="hc-notedrawer__spacer" />
          <span className="hc-notedrawer__kbd" title="노트 빠르게 열기">
            ⌘P
          </span>
          <Button variant="plain" size="sm" icon aria-label="파일 목록 닫기" data-sfx="back" onClick={onClose}>
            <GlyphClose width={14} height={14} />
          </Button>
        </div>
        <NoteTree
          vault={vault}
          openPath={openPath}
          onOpen={props.onOpenFile}
          onRenamed={props.onRenamed}
          onTrashed={props.onTrashed}
          draftRequest={props.draftRequest}
        />
      </div>
    </>
  );
});
