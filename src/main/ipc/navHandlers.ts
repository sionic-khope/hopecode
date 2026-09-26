// Invoke handlers behind the sidebar navigation pages (⌘K thread search, 풀 리퀘스트, 예약, 플러그인).
// Same rules as registerIpc: every request is narrowed from `unknown`; paths never come from the renderer.
import type { InvokeResponse } from '../../shared/ipc';
import type { PluginInventory } from '../../shared/nav';
import type { Store } from '../contracts';
import type { ThreadSearchIndex } from '../nav/threadSearchIndex';
import type { PrSource } from '../prs/prService';
import type { Scheduler } from '../schedule/scheduler';
import { assertReq, isBoolean, isNonEmptyString, isPlainObject, isString } from './guards';

export const NAV_CHANNELS = [
  'nav:threadFirstMessages',
  'prs:list',
  'prs:openExternal',
  'schedule:list',
  'schedule:save',
  'schedule:setEnabled',
  'schedule:delete',
  'plugins:list',
  'plugins:openFolder',
] as const;

export type NavChannel = (typeof NAV_CHANNELS)[number];
export type NavHandlers = { [K in NavChannel]: (req: unknown) => Promise<InvokeResponse<K>> };

/** PR pages open in the browser only on github.com. */
export const PR_URL_HOSTS: readonly string[] = ['github.com'];

export interface NavServices {
  threadSearch: ThreadSearchIndex;
  prSource: PrSource;
  /** openExternalSafe with PR_URL_HOSTS (a recording no-op in test runs); false when refused. */
  openExternal: (url: string) => boolean;
  scheduler: Scheduler;
  plugins: { list(): Promise<PluginInventory>; openFolder(): Promise<void> };
}

export function buildNavHandlers(store: Store, nav: NavServices): NavHandlers {
  return {
    'nav:threadFirstMessages': async () => nav.threadSearch.firstMessages(store.get().threads.map((t) => t.id)),

    'prs:list': async () => nav.prSource.list(store.get().projects),

    'prs:openExternal': async (req) => {
      assertReq('prs:openExternal', isPlainObject(req) && isString(req.url) && req.url.length <= 2048, 'url required');
      return nav.openExternal((req as { url: string }).url);
    },

    'schedule:list': async () => nav.scheduler.list(),

    'schedule:save': async (req) => {
      assertReq('schedule:save', isPlainObject(req) && isPlainObject(req.schedule), 'schedule required');
      const { id, schedule } = req as { id?: unknown; schedule: unknown };
      assertReq('schedule:save', id === undefined || isNonEmptyString(id), 'id must be a string');
      return nav.scheduler.save(schedule, id as string | undefined);
    },

    'schedule:setEnabled': async (req) => {
      assertReq('schedule:setEnabled', isPlainObject(req) && isNonEmptyString(req.id) && isBoolean(req.enabled), 'id/enabled required');
      const { id, enabled } = req as { id: string; enabled: boolean };
      return nav.scheduler.setEnabled(id, enabled);
    },

    'schedule:delete': async (req) => {
      assertReq('schedule:delete', isPlainObject(req) && isNonEmptyString(req.id), 'id required');
      await nav.scheduler.remove((req as { id: string }).id);
    },

    'plugins:list': async () => nav.plugins.list(),

    'plugins:openFolder': async () => nav.plugins.openFolder(),
  };
}
