import { useEffect, useState } from 'react';
import type { AppInfo } from '../../../shared/types';
import { tildePath } from '../../../core/format';
import { BrandMark, Button, Modal } from '../common';
import { GlyphKeyboard } from '../common/glyphs';
import './Shell.css';

/** Shortcut table: every entry is wired (app menu accelerators or the composer's own keys). */
export const SHORTCUTS: readonly { group: string; items: readonly { keys: string[]; label: string }[] }[] = [
  {
    group: '일반',
    items: [
      { keys: ['⌘', 'N'], label: '새 채팅' },
      { keys: ['⌘', '⇧', 'N'], label: 'New Task Start' },
      { keys: ['⌘', 'K'], label: '명령 팔레트' },
      { keys: ['⌘', ','], label: '설정' },
      { keys: ['⌘', 'B'], label: '사이드바 보기/숨기기' },
      { keys: ['⌘', 'Q'], label: 'Hopecode 종료' },
    ],
  },
  {
    group: '패널',
    items: [
      { keys: ['⌘', 'J'], label: '터미널 보기/숨기기' },
      { keys: ['⌘', '⇧', 'D'], label: '변경사항 패널 보기/숨기기' },
    ],
  },
  {
    group: '입력창',
    items: [
      { keys: ['⏎'], label: '보내기' },
      { keys: ['⇧', '⏎'], label: '줄바꿈' },
      { keys: ['⌘', '⏎'], label: '커밋 (커밋 창에서)' },
      { keys: ['esc'], label: '메뉴·창 닫기' },
    ],
  },
];

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="키보드 단축키" icon={<GlyphKeyboard width={18} height={18} />} width={520}>
      <div className="hc-shortcuts">
        {SHORTCUTS.map((g) => (
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
      title="Hopecode"
      subtitle="여러 Claude 계정으로 이어서 일하는 Claude Code 데스크탑"
      icon={<BrandMark size={36} />}
      className="hc-about"
      width={440}
      actions={
        <Button variant="primary" onClick={onClose} data-autofocus>
          확인
        </Button>
      }
    >
      {error ? <p className="hc-about__error">{error}</p> : null}
      <dl className="hc-kv" aria-label="버전 정보">
        <dt>앱 버전</dt>
        <dd>{info?.appVersion ?? '…'}</dd>
        <dt>Claude Code CLI</dt>
        <dd>{info ? (info.cliVersion ?? '알 수 없음') : '…'}</dd>
        <dt>Agent SDK</dt>
        <dd>{info ? (info.sdkVersion ?? '알 수 없음') : '…'}</dd>
        <dt>Electron</dt>
        <dd>{info?.electronVersion || '…'}</dd>
        <dt>데이터 폴더</dt>
        <dd>{info ? tildePath(info.dataDir, homeDir) : '…'}</dd>
      </dl>
    </Modal>
  );
}
