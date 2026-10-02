// macOS notifications (Notification API) while the window is in the background: a finished turn, a permission
// request, an account switch. Off in fixture / e2e runs and when 설정 > 알림 is off.
import { useEffect } from 'react';
import { on } from '../api';
import { useAppStore } from '../store';
import { t } from '../../shared/i18n';

export interface NotifyEvent {
  kind: 'turn-done' | 'permission' | 'account-switch';
  threadId: string;
  body: string;
}

/** Title + body for one event (pure; the thread title makes the notification recognisable). */
export function notificationText(event: NotifyEvent, threadTitle: string | null): { title: string; body: string } {
  const name = threadTitle ?? t('md.thread');
  switch (event.kind) {
    case 'turn-done':
      return { title: `${name} · ${t('notify.done')}`, body: event.body || t('notify.done.body') };
    case 'permission':
      return { title: `${name} · ${t('notify.permission')}`, body: event.body };
    case 'account-switch':
      return { title: `${name} · ${t('notify.accountSwitch')}`, body: event.body };
  }
}

/** Start of main's account-switch notice (`계정 전환: a → b`), in the language both processes share. */
function switchNoticePrefix(): string {
  return t('runner.switched').split('{')[0];
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
        if (event.type === 'item-upsert' && event.item.type === 'notice' && event.item.text.startsWith(switchNoticePrefix())) {
          show({ kind: 'account-switch', threadId, body: event.item.text });
        }
      }),
      on('permission:request', (req) =>
        show({ kind: 'permission', threadId: req.threadId, body: req.title ?? t('notify.permission.body', { tool: req.displayName ?? req.toolName }) }),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);
}
