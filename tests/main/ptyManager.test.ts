import { describe, expect, it, vi } from 'vitest';

type ExitCb = (e: { exitCode: number }) => void;
type DataCb = (d: string) => void;
interface FakeProc {
  dataCb: DataCb | null;
  exitCb: ExitCb | null;
  killed: boolean;
}
const procs: FakeProc[] = [];

vi.mock('node-pty', () => ({
  spawn: () => {
    const p: FakeProc = { dataCb: null, exitCb: null, killed: false };
    procs.push(p);
    return {
      onData: (cb: DataCb) => (p.dataCb = cb),
      onExit: (cb: ExitCb) => (p.exitCb = cb),
      write: () => {},
      resize: () => {},
      kill: () => {
        p.killed = true;
      },
    };
  },
}));

const { RingBuffer, createPtyManager } = await import('../../src/main/pty/ptyManager');
const { createRecordingBroadcaster, createStaticShellEnv } = await import('../../src/main/fixtures/memoryDeps');

describe('RingBuffer', () => {
  it('keeps only the newest maxBytes bytes', () => {
    const rb = new RingBuffer(10);
    rb.append('abcdef');
    rb.append('ghijkl');
    expect(rb.toString()).toBe('cdefghijkl');
    expect(rb.byteLength()).toBe(10);
  });

  it('never splits a multi-byte UTF-8 character', () => {
    const rb = new RingBuffer(5);
    rb.append('가나다'); // 9 bytes
    expect(rb.toString()).toBe('다');
    expect(rb.byteLength()).toBeLessThanOrEqual(5);
  });

  it('(H1) 10MB of 64KB chunks stays bounded and runs in well under a second', () => {
    const max = 256 * 1024;
    const rb = new RingBuffer(max);
    const chunk = 'x'.repeat(64 * 1024);
    const start = performance.now();
    for (let i = 0; i < 160; i++) rb.append(chunk);
    const elapsed = performance.now() - start;
    expect(rb.byteLength()).toBe(max);
    expect(rb.toString().length).toBe(max);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('ptyManager', () => {
  it('(L7) a late exit of a replaced shell does not drop the new session', () => {
    procs.length = 0;
    const broadcaster = createRecordingBroadcaster();
    const mgr = createPtyManager({ shellEnv: createStaticShellEnv(), broadcaster });
    mgr.open('t1', '/tmp', 80, 24);
    const first = procs[0]!;
    mgr.kill('t1');
    mgr.open('t1', '/tmp', 80, 24);
    const second = procs[1]!;
    first.exitCb?.({ exitCode: 0 });
    expect(broadcaster.of('pty:exit')).toEqual([]);

    first.dataCb?.('stale');
    second.dataCb?.('fresh');
    expect(mgr.open('t1', '/tmp', 80, 24).replay).toBe('fresh');

    second.exitCb?.({ exitCode: 3 });
    expect(broadcaster.of('pty:exit')).toEqual([{ threadId: 't1', code: 3 }]);
  });

  it('reopening the same session id with a different cwd kills the old shell and spawns a fresh one there', () => {
    procs.length = 0;
    const broadcaster = createRecordingBroadcaster();
    const mgr = createPtyManager({ shellEnv: createStaticShellEnv(), broadcaster });

    mgr.open('draft', '/home/fixture', 80, 24);
    const first = procs[0]!;
    expect(first.killed).toBe(false);

    // Same id, new cwd (the draft's folder chip changed): the old shell is replaced, not resized.
    const reopened = mgr.open('draft', '/work/other-project', 80, 24);
    expect(first.killed).toBe(true);
    expect(reopened.replay).toBe(''); // fresh shell, nothing to replay
    expect(procs).toHaveLength(2);

    // Reopening again with the same (new) cwd reuses the session instead of respawning.
    procs[1]!.dataCb?.('hello');
    expect(mgr.open('draft', '/work/other-project', 80, 24).replay).toBe('hello');
    expect(procs).toHaveLength(2);
  });
});
