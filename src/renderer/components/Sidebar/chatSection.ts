// Sidebar "채팅" section: chats without a project (scratch), newest first. Pinned ones live in 고정된 스레드 and
// archived ones in 보관됨, like project threads.
import type { Thread } from '../../../shared/types';

/** Rows of the 채팅 section from `selectChatThreads` (already scratch-only, unarchived, newest first). */
export function chatSectionThreads(chatThreads: readonly Thread[]): Thread[] {
  return chatThreads.filter((t) => t.projectId === null && !t.pinned && !t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
}
