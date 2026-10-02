import { useCallback, useEffect, useState } from 'react';
import type { PluginInventory, PluginItem, PluginItemKind } from '../../../shared/nav';
import { invoke } from '../../api';
import { copyText } from '../../clipboard';
import { ipcErrorMessage } from '../../errors';
import { tildePath } from '../../../core/format';
import { Button, Pill } from '../common';
import { GlyphCopy, GlyphFolderOpen, GlyphRefresh } from '../common/glyphs';
import { PageHeader, PageSection } from './PageHeader';
import { t, type MessageKey } from '../../../shared/i18n';
import { tNodes } from '../../i18n';

const SECTIONS: readonly { kind: PluginItemKind; title: MessageKey }[] = [
  { kind: 'plugin', title: 'nav.plugins' },
  { kind: 'skill', title: 'plugins.skills' },
  { kind: 'agent', title: 'agent.title' },
  { kind: 'output-style', title: 'plugins.outputStyles' },
  { kind: 'mcp', title: 'plugins.mcp' },
  { kind: 'hook', title: 'plugins.hooks' },
];

const PLUGIN_COMMAND = 'claude /plugin';

function EnabledPill({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) return null;
  return enabled ? <Pill tone="ok">{t('plugins.enabled')}</Pill> : <Pill>{t('accountPin.disabled')}</Pill>;
}

/**
 * 플러그인: what the shared ~/.claude gives every account (plugins, skills, agents, output styles, MCP servers,
 * hooks). Read-only; changes go through `claude /plugin` in a terminal.
 */
export function PluginsPage({ homeDir, onBack }: { homeDir: string | null; onBack: () => void }) {
  const [inventory, setInventory] = useState<PluginInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setError(null);
    invoke('plugins:list')
      .then(setInventory)
      .catch((err: unknown) => setError(t('plugins.err.list', { error: ipcErrorMessage(err) })));
  }, []);
  useEffect(load, [load]);

  const openFolder = () => void invoke('plugins:openFolder').catch((err: unknown) => setError(t('plugins.err.folder', { error: ipcErrorMessage(err) })));
  const copyCommand = () =>
    void copyText(PLUGIN_COMMAND).then((ok) => {
      setCopied(ok);
      if (ok) window.setTimeout(() => setCopied(false), 1500);
    });

  const byKind = (kind: PluginItemKind): PluginItem[] => inventory?.items.filter((i) => i.kind === kind) ?? [];

  return (
    <div className="hc-page" data-testid="plugins-page">
      <PageHeader
        title={t('nav.plugins')}
        lede={t('plugins.lede')}
        onBack={onBack}
        actions={
          <>
            <Button size="sm" onClick={load}>
              <GlyphRefresh width={14} height={14} />
              {t('prs.refresh')}
            </Button>
            {inventory?.exists ? (
              <Button size="sm" onClick={openFolder}>
                <GlyphFolderOpen width={14} height={14} />
                {t('plugins.openFolder')}
              </Button>
            ) : null}
          </>
        }
      />

      {error ? (
        <div className="hc-page__notice hc-page__notice--error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="hc-page__notice">
        {tNodes('plugins.manage', { command: <code>{PLUGIN_COMMAND}</code> })}
        <div className="hc-page__cmd">
          <Button size="sm" variant="plain" onClick={copyCommand}>
            <GlyphCopy width={14} height={14} />
            {copied ? t('common.copied') : t('plugins.copyCommand')}
          </Button>
          {inventory ? <span className="hc-page__mono">{tildePath(inventory.sourceDir, homeDir)}</span> : null}
        </div>
      </div>

      {inventory && !inventory.exists ? (
        <div className="hc-page__notice" role="status">
          {t('plugins.noSource')}
        </div>
      ) : null}

      {inventory?.exists && inventory.items.length === 0 && inventory.problems.length === 0 ? (
        <div className="hc-page__notice" role="status">
          {t('plugins.empty')}
        </div>
      ) : null}

      {SECTIONS.map(({ kind, title }) => {
        const items = byKind(kind);
        if (items.length === 0) return null;
        return (
          <PageSection key={kind} title={t(title)} meta={t('plugins.count', { count: items.length })}>
            <ul className="hc-page__card hc-page__list" aria-label={t(title)}>
              {items.map((item, i) => (
                <li key={`${item.source}:${item.name}:${i}`} className="hc-page__row" data-testid="plugin-item">
                  <div className="hc-page__row-main">
                    <div className="hc-page__row-title">
                      <span>{item.name}</span>
                      {item.detail && kind === 'plugin' ? <span className="hc-page__num">{item.detail}</span> : null}
                    </div>
                    {item.description ? <p className="hc-page__row-desc">{item.description}</p> : null}
                    <div className="hc-page__row-sub">
                      <span>{t('localAuth.source')} {item.source}</span>
                      {item.detail && kind !== 'plugin' ? <span className="hc-page__mono">{item.detail}</span> : null}
                    </div>
                  </div>
                  <div className="hc-page__row-actions">
                    <EnabledPill enabled={item.enabled} />
                  </div>
                </li>
              ))}
            </ul>
          </PageSection>
        );
      })}

      {inventory && inventory.problems.length > 0 ? (
        <PageSection title={t('plugins.problems')} meta={t('plugins.skipped', { count: inventory.problems.length })}>
          <ul className="hc-page__card hc-page__list" aria-label={t('plugins.problems')}>
            {inventory.problems.map((p) => (
              <li key={p.path} className="hc-page__row">
                <div className="hc-page__row-main">
                  <div className="hc-page__row-title">
                    <span className="hc-page__mono">{p.path}</span>
                  </div>
                  <p className="hc-page__row-desc">{p.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </PageSection>
      ) : null}
    </div>
  );
}
