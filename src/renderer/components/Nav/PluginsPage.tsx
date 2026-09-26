import { useCallback, useEffect, useState } from 'react';
import type { PluginInventory, PluginItem, PluginItemKind } from '../../../shared/nav';
import { invoke } from '../../api';
import { copyText } from '../../clipboard';
import { ipcErrorMessage } from '../../errors';
import { tildePath } from '../../../core/format';
import { Button, Pill } from '../common';
import { GlyphCopy, GlyphFolderOpen, GlyphRefresh } from '../common/glyphs';
import { PageHeader, PageSection } from './PageHeader';

const SECTIONS: readonly { kind: PluginItemKind; title: string }[] = [
  { kind: 'plugin', title: '플러그인' },
  { kind: 'skill', title: '스킬' },
  { kind: 'agent', title: '에이전트' },
  { kind: 'output-style', title: '출력 스타일' },
  { kind: 'mcp', title: 'MCP 서버' },
  { kind: 'hook', title: 'Hooks' },
];

const PLUGIN_COMMAND = 'claude /plugin';

function EnabledPill({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) return null;
  return enabled ? <Pill tone="ok">활성</Pill> : <Pill>비활성</Pill>;
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
      .catch((err: unknown) => setError(`목록을 읽지 못했습니다: ${ipcErrorMessage(err)}`));
  }, []);
  useEffect(load, [load]);

  const openFolder = () => void invoke('plugins:openFolder').catch((err: unknown) => setError(`폴더를 열지 못했습니다: ${ipcErrorMessage(err)}`));
  const copyCommand = () =>
    void copyText(PLUGIN_COMMAND).then((ok) => {
      setCopied(ok);
      if (ok) window.setTimeout(() => setCopied(false), 1500);
    });

  const byKind = (kind: PluginItemKind): PluginItem[] => inventory?.items.filter((i) => i.kind === kind) ?? [];

  return (
    <div className="hc-page" data-testid="plugins-page">
      <PageHeader
        title="플러그인"
        lede="모든 계정이 함께 쓰는 Claude 설정 폴더의 확장 기능입니다. 여기서는 읽기만 합니다."
        onBack={onBack}
        actions={
          <>
            <Button size="sm" onClick={load}>
              <GlyphRefresh width={14} height={14} />
              새로고침
            </Button>
            {inventory?.exists ? (
              <Button size="sm" onClick={openFolder}>
                <GlyphFolderOpen width={14} height={14} />
                폴더 열기
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
        설치, 제거, 활성화는 터미널에서 <code>{PLUGIN_COMMAND}</code>을 실행해 관리하세요. 바뀐 내용은 새로고침하면 보입니다.
        <div className="hc-page__cmd">
          <Button size="sm" variant="plain" onClick={copyCommand}>
            <GlyphCopy width={14} height={14} />
            {copied ? '복사됨' : '명령 복사'}
          </Button>
          {inventory ? <span className="hc-page__mono">{tildePath(inventory.sourceDir, homeDir)}</span> : null}
        </div>
      </div>

      {inventory && !inventory.exists ? (
        <div className="hc-page__notice" role="status">
          공유 설정 폴더가 없습니다. Claude Code를 한 번 실행하면 만들어집니다.
        </div>
      ) : null}

      {inventory?.exists && inventory.items.length === 0 && inventory.problems.length === 0 ? (
        <div className="hc-page__notice" role="status">
          설치된 플러그인, 스킬, 에이전트가 없습니다.
        </div>
      ) : null}

      {SECTIONS.map(({ kind, title }) => {
        const items = byKind(kind);
        if (items.length === 0) return null;
        return (
          <PageSection key={kind} title={title} meta={`${items.length}개`}>
            <ul className="hc-page__card hc-page__list" aria-label={title}>
              {items.map((item, i) => (
                <li key={`${item.source}:${item.name}:${i}`} className="hc-page__row" data-testid="plugin-item">
                  <div className="hc-page__row-main">
                    <div className="hc-page__row-title">
                      <span>{item.name}</span>
                      {item.detail && kind === 'plugin' ? <span className="hc-page__num">{item.detail}</span> : null}
                    </div>
                    {item.description ? <p className="hc-page__row-desc">{item.description}</p> : null}
                    <div className="hc-page__row-sub">
                      <span>출처 {item.source}</span>
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
        <PageSection title="읽지 못한 항목" meta={`${inventory.problems.length}개 건너뜀`}>
          <ul className="hc-page__card hc-page__list" aria-label="읽지 못한 항목">
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
