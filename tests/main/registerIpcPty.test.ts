// pty:open/write/resize validation for the reserved draft session (H1: the terminal must work before any
// thread exists -- ⌘J from the "new chat" screen). See src/main/ipc/registerIpc.ts (requirePtySessionId,
// resolvePtyCwd).
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { registerIpc, type IpcMainLike, type RegisterIpcServices } from '../../src/main/ipc/registerIpc';
import { InvalidIpcRequestError } from '../../src/main/ipc/guards';
import { createMemoryStore, createRecordingBroadcaster, makeThread } from '../../src/main/fixtures/memoryDeps';
import type { PtyManager, Store } from '../../src/main/contracts';
import type { Project } from '../../src/shared/types';
import { DRAFT_PTY_SESSION_ID } from '../../src/shared/constants';

function makeProject(id: string, over: Partial<Project> = {}): Project {
  return { id, name: id, path: `/projects/${id}`, trusted: true, createdAt: 0, ...over };
}

interface FakePtyManager extends PtyManager {
  opens: { threadId: string; cwd: string; cols: number; rows: number }[];
  writes: { threadId: string; data: string }[];
  resizes: { threadId: string; cols: number; rows: number }[];
}

function createFakePtyManager(): FakePtyManager {
  const opens: FakePtyManager['opens'] = [];
  const writes: FakePtyManager['writes'] = [];
  const resizes: FakePtyManager['resizes'] = [];
  return {
    opens,
    writes,
    resizes,
    open(threadId, cwd, cols, rows) {
      opens.push({ threadId, cwd, cols, rows });
      return { ptyId: threadId, replay: '' };
    },
    write(threadId, data) {
      writes.push({ threadId, data });
    },
    resize(threadId, cols, rows) {
      resizes.push({ threadId, cols, rows });
    },
    kill() {},
    killAll() {},
  };
}

/** Captures every `ipcMain.handle` registration so a handler can be invoked directly, like a real invoke. */
function createFakeIpcMain(): IpcMainLike & { invoke: (channel: string, req: unknown) => Promise<unknown> } {
  const handlers = new Map<string, (event: unknown, req: unknown) => unknown>();
  return {
    handle(channel, listener) {
      handlers.set(channel, listener as never);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    invoke(channel, req) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for ${channel}`);
      return handler({ senderFrame: { url: 'app://trusted' } }, req) as Promise<unknown>;
    },
  };
}

function setup(store: Store, ptyManager: PtyManager) {
  const services = {
    store,
    ptyManager,
    broadcaster: createRecordingBroadcaster(),
    appVersion: '0.0.0-test',
    isTrustedSender: () => true,
    testMode: true,
    // registerIpc unconditionally subscribes these two on every call.
    accountPool: { onChange: () => () => {} },
    usagePoller: { onUpdate: () => () => {} },
  } as unknown as RegisterIpcServices;
  const ipcMain = createFakeIpcMain();
  registerIpc(ipcMain, services);
  return ipcMain;
}

describe('pty:open (draft session)', () => {
  it('uses the given project folder as cwd when projectId is a known project', async () => {
    const store = createMemoryStore({ projects: [makeProject('p1', { path: '/work/p1' })] });
    const pty = createFakePtyManager();
    const ipcMain = setup(store, pty);

    const res = await ipcMain.invoke('pty:open', { threadId: DRAFT_PTY_SESSION_ID, cols: 80, rows: 24, projectId: 'p1' });
    expect(res).toEqual({ ptyId: DRAFT_PTY_SESSION_ID, replay: '' });
    expect(pty.opens).toEqual([{ threadId: DRAFT_PTY_SESSION_ID, cwd: '/work/p1', cols: 80, rows: 24 }]);
  });

  it('falls back to the home folder when no projectId is given', async () => {
    const store = createMemoryStore();
    const pty = createFakePtyManager();
    const ipcMain = setup(store, pty);

    await ipcMain.invoke('pty:open', { threadId: DRAFT_PTY_SESSION_ID, cols: 80, rows: 24 });
    expect(pty.opens).toEqual([{ threadId: DRAFT_PTY_SESSION_ID, cwd: homedir(), cols: 80, rows: 24 }]);
  });

  it('falls back to the home folder when projectId does not exist in the store (never a raw path)', async () => {
    const store = createMemoryStore({ projects: [makeProject('p1', { path: '/work/p1' })] });
    const pty = createFakePtyManager();
    const ipcMain = setup(store, pty);

    await ipcMain.invoke('pty:open', {
      threadId: DRAFT_PTY_SESSION_ID,
      cols: 80,
      rows: 24,
      projectId: '/etc/not-a-real-project-id',
    });
    expect(pty.opens).toEqual([{ threadId: DRAFT_PTY_SESSION_ID, cwd: homedir(), cols: 80, rows: 24 }]);
  });

  it('still uses the thread cwd for a real thread id, ignoring projectId', async () => {
    const store = createMemoryStore({
      projects: [makeProject('p1', { path: '/work/p1' })],
      threads: [makeThread('t1', { cwd: '/work/t1-worktree' })],
    });
    const pty = createFakePtyManager();
    const ipcMain = setup(store, pty);

    await ipcMain.invoke('pty:open', { threadId: 't1', cols: 80, rows: 24, projectId: 'p1' });
    expect(pty.opens).toEqual([{ threadId: 't1', cwd: '/work/t1-worktree', cols: 80, rows: 24 }]);
  });

  it('rejects a threadId that is neither a real thread nor the draft id', async () => {
    const store = createMemoryStore();
    const pty = createFakePtyManager();
    const ipcMain = setup(store, pty);

    await expect(ipcMain.invoke('pty:open', { threadId: 'not-a-thread', cols: 80, rows: 24 })).rejects.toThrow(
      InvalidIpcRequestError,
    );
    expect(pty.opens).toEqual([]);
  });
});

describe('pty:write / pty:resize (draft session)', () => {
  it('accept the draft session id', async () => {
    const store = createMemoryStore();
    const pty = createFakePtyManager();
    const ipcMain = setup(store, pty);

    await ipcMain.invoke('pty:write', { threadId: DRAFT_PTY_SESSION_ID, data: 'pwd\r' });
    await ipcMain.invoke('pty:resize', { threadId: DRAFT_PTY_SESSION_ID, cols: 100, rows: 30 });

    expect(pty.writes).toEqual([{ threadId: DRAFT_PTY_SESSION_ID, data: 'pwd\r' }]);
    expect(pty.resizes).toEqual([{ threadId: DRAFT_PTY_SESSION_ID, cols: 100, rows: 30 }]);
  });

  it('reject a threadId that is neither a real thread nor the draft id', async () => {
    const store = createMemoryStore();
    const pty = createFakePtyManager();
    const ipcMain = setup(store, pty);

    await expect(ipcMain.invoke('pty:write', { threadId: 'ghost', data: 'x' })).rejects.toThrow(InvalidIpcRequestError);
    await expect(ipcMain.invoke('pty:resize', { threadId: 'ghost', cols: 80, rows: 24 })).rejects.toThrow(
      InvalidIpcRequestError,
    );
    expect(pty.writes).toEqual([]);
    expect(pty.resizes).toEqual([]);
  });
});
