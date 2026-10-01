// AttachmentStore.fromPath open flags (security review L2): O_NOFOLLOW refuses a symlink swapped in after realpath,
// O_NONBLOCK keeps a FIFO swapped in after the stat from hanging the open. The races are simulated by making
// realpath / stat report what the checks would have seen before the swap.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const swap = vi.hoisted(() => ({ realpathIdentity: false, statAs: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    realpath: (async (p: string) => (swap.realpathIdentity ? p : actual.realpath(p))) as typeof actual.realpath,
    stat: (async (p: string) => actual.stat(swap.statAs ?? p)) as typeof actual.stat,
  };
});

const { AttachmentStore } = await import('../../src/main/attachments/attachmentStore');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hopecode-attach-open-'));
});
afterEach(() => {
  swap.realpathIdentity = false;
  swap.statAs = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('AttachmentStore.fromPath open flags', () => {
  it('O_NOFOLLOW: a path that is a symlink at open time is refused', async () => {
    const target = join(dir, 'secret.txt');
    writeFileSync(target, 'secret');
    const link = join(dir, 'notes.txt');
    symlinkSync(target, link);
    swap.realpathIdentity = true; // realpath ran before the swap: it saw a plain file at `link`
    const store = new AttachmentStore();
    await expect(store.fromPath(link)).rejects.toMatchObject({ reason: '일반 파일만 첨부할 수 있습니다' });
  });

  it('O_NONBLOCK: a FIFO swapped in after the stat neither hangs the open nor is read', async () => {
    const plain = join(dir, 'plain.txt');
    writeFileSync(plain, 'hello');
    const fifo = join(dir, 'pipe.txt');
    execFileSync('mkfifo', [fifo]);
    swap.statAs = plain; // the pre-open stat saw a regular file
    const store = new AttachmentStore();
    await expect(store.fromPath(fifo)).rejects.toMatchObject({ reason: '일반 파일만 첨부할 수 있습니다' });
  }, 5_000);
});
