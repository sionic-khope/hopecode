// One node-pty shell per thread (plan 3.2 / 4.2 pty/ptyManager.ts).
// Kept alive across thread switches; renderer reload replays the 256KB ring buffer.
// `childEnv({ term })` is used with no `configDir` injected -- the terminal pane is a plain
// user shell, not an SDK session.
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { PTY_RING_BUFFER_BYTES, TERMINAL_TERM } from '../../shared/constants';
import type { Broadcaster, PtyManager, ShellEnv } from '../contracts';

/**
 * Byte-bounded replay buffer: chunks + running byte total, trimming whole chunks from the front
 * (O(1) amortized per append). Only the oldest surviving chunk is ever cut, on a character boundary.
 */
export class RingBuffer {
  private chunks: string[] = [];
  private head = 0;
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    while (this.bytes > this.maxBytes && this.head < this.chunks.length) {
      const first = this.chunks[this.head]!;
      const size = Buffer.byteLength(first, 'utf8');
      if (this.bytes - size >= this.maxBytes) {
        this.bytes -= size;
        this.head += 1;
        continue;
      }
      // Cut the front of this chunk so exactly <= maxBytes remain, without splitting a UTF-8 sequence.
      const excess = this.bytes - this.maxBytes;
      const buf = Buffer.from(first, 'utf8');
      let cut = excess;
      while (cut < buf.length && (buf[cut]! & 0xc0) === 0x80) cut += 1;
      const rest = buf.subarray(cut).toString('utf8');
      this.chunks[this.head] = rest;
      this.bytes -= size - Buffer.byteLength(rest, 'utf8');
    }
    // Compact the dropped prefix occasionally so the array does not grow without bound.
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  byteLength(): number {
    return this.bytes;
  }

  toString(): string {
    return this.chunks.slice(this.head).join('');
  }
}

interface Session {
  proc: IPty;
  buffer: RingBuffer;
}

export interface PtyManagerDeps {
  shellEnv: ShellEnv;
  broadcaster: Broadcaster;
}

export function createPtyManager(deps: PtyManagerDeps): PtyManager {
  const sessions = new Map<string, Session>();

  function spawnSession(threadId: string, cwd: string, cols: number, rows: number): Session {
    const shell = deps.shellEnv.baseEnv()['SHELL'] || '/bin/zsh';
    const proc = pty.spawn(shell, ['-l'], {
      name: TERMINAL_TERM,
      cols,
      rows,
      cwd,
      env: deps.shellEnv.childEnv({ term: TERMINAL_TERM }),
    });
    const session: Session = { proc, buffer: new RingBuffer(PTY_RING_BUFFER_BYTES) };

    proc.onData((data) => {
      if (sessions.get(threadId) !== session) return;
      session.buffer.append(data);
      deps.broadcaster.emit('pty:data', { threadId, data });
    });
    proc.onExit(({ exitCode }) => {
      // A killed-and-respawned thread shell must not be dropped by the old process's late exit (L7).
      const current = sessions.get(threadId);
      if (current && current !== session) return;
      sessions.delete(threadId);
      deps.broadcaster.emit('pty:exit', { threadId, code: exitCode });
    });

    sessions.set(threadId, session);
    return session;
  }

  function killSession(threadId: string): void {
    const session = sessions.get(threadId);
    if (!session) return;
    session.proc.kill();
    sessions.delete(threadId);
  }

  return {
    open(threadId, cwd, cols, rows) {
      const existing = sessions.get(threadId);
      if (existing) {
        existing.proc.resize(cols, rows);
        return { ptyId: threadId, replay: existing.buffer.toString() };
      }
      spawnSession(threadId, cwd, cols, rows);
      return { ptyId: threadId, replay: '' };
    },
    write(threadId, data) {
      sessions.get(threadId)?.proc.write(data);
    },
    resize(threadId, cols, rows) {
      sessions.get(threadId)?.proc.resize(cols, rows);
    },
    kill(threadId) {
      killSession(threadId);
    },
    killAll() {
      for (const threadId of [...sessions.keys()]) killSession(threadId);
    },
  };
}
