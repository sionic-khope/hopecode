import { useEffect, useState } from 'react';
import type { AppInfo } from '../../../shared/types';
import { tildePath } from '../../../core/format';
import { BrandMark, Button, Modal } from '../common';
import { GlyphKeyboard } from '../common/glyphs';
import { t } from '../../../shared/i18n';
import './Shell.css';

/** Shortcut table: every entry is wired (app menu accelerators, the turn scrubber's or the composer's own keys). */
export function shortcuts(): { group: string; items: { keys: string[]; label: string }[] }[] {
  return [
    {
      group: t('settings.general'),
      items: [
        { keys: ['⌘', 'N'], label: t('menu.newChat') },
        { keys: ['⌘', '⇧', 'N'], label: t('menu.newTaskStart') },
        { keys: ['⌘', 'K'], label: t('menu.commandPalette') },
        { keys: ['⌘', ','], label: t('settings.title') },
        { keys: ['⌘', 'B'], label: t('menu.toggleSidebar') },
        { keys: ['⌘', 'Q'], label: t('profile.quit') },
      ],
    },
    {
      group: t('shortcuts.panels'),
      items: [
        { keys: ['⌘', 'J'], label: t('menu.toggleTerminal') },
        { keys: ['⌘', '⇧', 'D'], label: t('menu.toggleChanges') },
      ],
    },
    {
      group: t('shortcuts.conversation'),
      items: [
        { keys: ['⌥', '↑'], label: t('shortcuts.prevTurn') },
        { keys: ['⌥', '↓'], label: t('shortcuts.nextTurn') },
        { keys: ['B'], label: t('shortcuts.bookmark') },
      ],
    },
    {
      group: t('shortcuts.composer'),
      items: [
        { keys: ['⏎'], label: t('composer.send') },
        { keys: ['⇧', '⏎'], label: t('shortcuts.newline') },
        { keys: ['⌘', '⏎'], label: t('shortcuts.commit') },
        { keys: ['esc'], label: t('shortcuts.closeMenus') },
      ],
    },
  ];
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={t('nav.shortcuts')} icon={<GlyphKeyboard width={18} height={18} />} width={520}>
      <div className="hc-shortcuts">
        {shortcuts().map((g) => (
          <section key={g.group} className="hc-shortcuts__group" aria-label={g.group}>
            <h3 className="hc-shortcuts__title">{g.group}</h3>
            <ul className="hc-shortcuts__list">
              {g.items.map((item) => (
                <li key={item.label} className="hc-shortcuts__row">
                  <span>{item.label}</span>
                  <span className="hc-shortcuts__keys">
                    {item.keys.map((k) => (
                      <kbd key={k} className="hc-kbd">
                        {k}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

export function AboutModal({
  open,
  onClose,
  loadInfo,
  homeDir,
}: {
  open: boolean;
  onClose: () => void;
  loadInfo: () => Promise<AppInfo>;
  homeDir: string | null;
}) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadInfo()
      .then((i) => live && setInfo(i))
      .catch((err: unknown) => live && setError(String(err)));
    return () => {
      live = false;
    };
  }, [open, loadInfo]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="deltax"
      subtitle={t('about.subtitle')}
      icon={<BrandMark size={32} />}
      className="hc-about"
      width={440}
      actions={
        <Button variant="primary" onClick={onClose} data-autofocus>
          {t('common.confirm')}
        </Button>
      }
    >
      {error ? <p className="hc-about__error">{error}</p> : null}
      <dl className="hc-kv" aria-label={t('about.versions')}>
        <dt>{t('about.appVersion')}</dt>
        <dd>{info?.appVersion ?? '…'}</dd>
        <dt>Claude Code CLI</dt>
        <dd>{info ? (info.cliVersion ?? t('about.unknown')) : '…'}</dd>
        <dt>Agent SDK</dt>
        <dd>{info ? (info.sdkVersion ?? t('about.unknown')) : '…'}</dd>
        <dt>Electron</dt>
        <dd>{info?.electronVersion || '…'}</dd>
        <dt>{t('settings.dataFolder')}</dt>
        <dd>{info ? tildePath(info.dataDir, homeDir) : '…'}</dd>
      </dl>
    </Modal>
  );
}
