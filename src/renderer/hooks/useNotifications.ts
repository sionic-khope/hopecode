// macOS notifications (Notification API) while the window is in the background: a finished turn, a permission
// request, an account switch. Off in fixture / e2e runs and when 설정 > 알림 is off.
import { useEffect } from 'react';
import { on } from '../api';
import { useAppStore } from '../store';

export interface NotifyEvent {
  kind: 'turn-done' | 'permission' | 'account-switch';
  threadId: string;
  body: string;
}

/** Title + body for one event (pure; the thread title makes the notification recognisable). */
export function notificationText(event: NotifyEvent, threadTitle: string | null): { title: string; body: string } {
  const name = threadTitle ?? '스레드';
  switch (event.kind) {
    case 'turn-done':
      return { title: `${name} · 완료`, body: event.body || '응답이 끝났습니다.' };
    case 'permission':
      return { title: `${name} · 권한 요청`, body: event.body };
    case 'account-switch':
      return { title: `${name} · 계정 전환`, body: event.body };
  }
}

function shouldNotify(): boolean {
  const s = useAppStore.getState();
  if (s.testMode || !s.settings.notifications) return false;
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return false;
  return document.hidden || !document.hasFocus();
}

function show(event: NotifyEvent): void {
  if (!shouldNotify()) return;
  const s = useAppStore.getState();
  const thread = s.threads.find((t) => t.id === event.threadId) ?? null;
  const { title, body } = notificationText(event, thread?.title ?? null);
  const n = new Notification(title, { body, tag: `${event.kind}:${event.threadId}` });
  n.onclick = () => {
    window.focus();
    const st = useAppStore.getState();
    st.selectThread(event.threadId);
    st.setRoute('chat');
  };
}

/** Last assistant text of a thread, trimmed to a notification-sized line. */
function lastAssistantLine(threadId: string): string {
  const items = useAppStore.getState().chatItemsByThread[threadId] ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === 'assistant-text' && item.text.trim()) {
      const line = item.text.trim().replace(/\s+/g, ' ');
      return line.length > 120 ? `${line.slice(0, 119)}…` : line;
    }
  }
  return '';
}

export function useNotifications(): void {
  useEffect(() => {
    const offs = [
      on('chat:event', ({ threadId, event }) => {
        if (event.type === 'turn-end' && event.ok) show({ kind: 'turn-done', threadId, body: lastAssistantLine(threadId) });
        if (event.type === 'item-upsert' && event.item.type === 'notice' && event.item.text.startsWith('계정 전환')) {
          show({ kind: 'account-switch', threadId, body: event.item.text });
        }
      }),
      on('permission:request', (req) =>
        show({ kind: 'permission', threadId: req.threadId, body: req.title ?? `${req.displayName ?? req.toolName} 실행을 허용할까요?` }),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);
}
