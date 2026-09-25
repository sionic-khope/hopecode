// IPC contract (plan 3.3). Every renderer <-> main message passes through these types.
import type {
  Account,
  AccountPatch,
  BootstrapPayload,
  ChatEvent,
  ChatItem,
  ChatSendResult,
  ModelOption,
  PermissionDecision,
  PermissionRequest,
  PoolSnapshot,
  Project,
  Thread,
  UiPermissionMode,
  UsageSample,
} from './types';

/** renderer -> main (`ipcRenderer.invoke`). `req: void` means no argument. */
export interface InvokeMap {
  'app:bootstrap': { req: void; res: BootstrapPayload };
  'project:add': { req: void; res: Project | null };
  'project:remove': { req: { projectId: string }; res: void };
  /** Turning trust on shows a native confirm dialog in main; the returned project carries the applied value. */
  'project:setTrusted': { req: { projectId: string; trusted: boolean }; res: Project };
  'thread:create': {
    req: { projectId: string; title?: string; model?: string; permissionMode?: UiPermissionMode };
    res: Thread;
  };
  'thread:rename': { req: { threadId: string; title: string }; res: void };
  /**
   * `removeWorktree` with a dirty worktree and no `force` deletes nothing and returns `worktree-dirty`;
   * the renderer confirms with the user and re-sends with `force: true`.
   */
  'thread:delete': {
    req: { threadId: string; removeWorktree: boolean; force?: boolean };
    res: { ok: true } | { ok: false; reason: 'worktree-dirty' };
  };
  'thread:setModel': { req: { threadId: string; model: string }; res: void };
  /** `bypassPermissions` needs a native confirm in main; the applied mode always arrives via `thread:updated`. */
  'thread:setPermissionMode': { req: { threadId: string; mode: UiPermissionMode }; res: void };
  'thread:pinAccount': { req: { threadId: string; accountId: string | null }; res: void };
  'chat:history': { req: { threadId: string }; res: ChatItem[] };
  'chat:send': { req: { threadId: string; text: string }; res: ChatSendResult };
  'chat:interrupt': { req: { threadId: string }; res: void };
  'permission:respond': {
    req: { requestId: string; decision: PermissionDecision; message?: string };
    res: void;
  };
  'models:list': { req: void; res: ModelOption[] };
  'account:loginStart': { req: { alias: string; color: string }; res: { loginId: string; accountId: string } };
  'account:loginInput': { req: { loginId: string; data: string }; res: void };
  'account:loginCancel': { req: { loginId: string }; res: void };
  'account:update': { req: { accountId: string; patch: AccountPatch }; res: Account };
  'account:reorder': { req: { orderedIds: string[] }; res: void };
  /** Refused (`ok: false`) when threads depend on the account's transcripts and no other enabled account remains. */
  'account:remove': {
    req: { accountId: string; deleteConfigDir: boolean };
    res: { ok: true } | { ok: false; error: string };
  };
  'usage:refresh': { req: { accountId?: string }; res: PoolSnapshot };
  'usage:history': { req: { accountId: string; rangeMs: number }; res: UsageSample[] };
  'pty:open': { req: { threadId: string; cols: number; rows: number }; res: { ptyId: string; replay: string } };
  'pty:write': { req: { threadId: string; data: string }; res: void };
  'pty:resize': { req: { threadId: string; cols: number; rows: number }; res: void };
}

/** main -> renderer (`webContents.send`). */
export interface EventMap {
  'chat:event': { threadId: string; event: ChatEvent };
  'thread:updated': Thread;
  'permission:request': PermissionRequest;
  'permission:cancel': { requestId: string };
  'usage:updated': PoolSnapshot;
  'account:updated': Account[];
  'login:data': { loginId: string; data: string };
  'login:exit': { loginId: string; ok: boolean; account?: Account; error?: string };
  'pty:data': { threadId: string; data: string };
  'pty:exit': { threadId: string; code: number };
  /** Menu View > Toggle Terminal (⌘J); the renderer has no keydown handler for it. */
  'ui:toggleTerminal': void;
  /** Menu File > New Thread (⌘N). */
  'ui:newThread': void;
}

export type InvokeChannel = keyof InvokeMap;
export type EventChannel = keyof EventMap;
export type InvokeRequest<K extends InvokeChannel> = InvokeMap[K]['req'];
export type InvokeResponse<K extends InvokeChannel> = InvokeMap[K]['res'];
export type EventPayload<K extends EventChannel> = EventMap[K];

// `satisfies` keeps the arrays exhaustive: adding a channel to the map without listing it fails typecheck.
export const INVOKE_CHANNELS = [
  'app:bootstrap',
  'project:add',
  'project:remove',
  'project:setTrusted',
  'thread:create',
  'thread:rename',
  'thread:delete',
  'thread:setModel',
  'thread:setPermissionMode',
  'thread:pinAccount',
  'chat:history',
  'chat:send',
  'chat:interrupt',
  'permission:respond',
  'models:list',
  'account:loginStart',
  'account:loginInput',
  'account:loginCancel',
  'account:update',
  'account:reorder',
  'account:remove',
  'usage:refresh',
  'usage:history',
  'pty:open',
  'pty:write',
  'pty:resize',
] as const satisfies readonly InvokeChannel[];

export const EVENT_CHANNELS = [
  'chat:event',
  'thread:updated',
  'permission:request',
  'permission:cancel',
  'usage:updated',
  'account:updated',
  'login:data',
  'login:exit',
  'pty:data',
  'pty:exit',
  'ui:toggleTerminal',
  'ui:newThread',
] as const satisfies readonly EventChannel[];

type Missing<All, Listed> = Exclude<All, Listed>;
// Compile-time exhaustiveness: these resolve to `true` only when every channel is listed.
const invokeExhaustive: Missing<InvokeChannel, (typeof INVOKE_CHANNELS)[number]> extends never ? true : false = true;
const eventExhaustive: Missing<EventChannel, (typeof EVENT_CHANNELS)[number]> extends never ? true : false = true;
void invokeExhaustive;
void eventExhaustive;

const invokeSet: ReadonlySet<string> = new Set(INVOKE_CHANNELS);
const eventSet: ReadonlySet<string> = new Set(EVENT_CHANNELS);

export function isInvokeChannel(ch: unknown): ch is InvokeChannel {
  return typeof ch === 'string' && invokeSet.has(ch);
}

export function isEventChannel(ch: unknown): ch is EventChannel {
  return typeof ch === 'string' && eventSet.has(ch);
}

/** Shape exposed on `window.hopecode` by the preload script. */
export interface HopecodeApi {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...req: InvokeRequest<K> extends void ? [] : [InvokeRequest<K>]
  ): Promise<InvokeResponse<K>>;
  on<K extends EventChannel>(channel: K, cb: (payload: EventPayload<K>) => void): () => void;
}
