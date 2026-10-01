// AcpConnection against real child processes: the Lane D fixture agent (tests/fixtures/acp/fakeAcpAgent.mjs) and a
// tiny raw NDJSON agent for protocol / process edge cases. No real codex-acp / hermes is started.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcpAbortedError,
  AcpConnection,
  AcpProcessExitedError,
  AcpProtocolVersionError,
  AcpSpawnError,
  AcpTimeoutError,
  ACP_DISPOSE_BUDGET_MS,
} from '../../src/main/acp/acpConnection';
import type { AcpLaunchSpec } from '../../src/main/contracts';

const FAKE_AGENT = resolve(__dirname, '../fixtures/acp/fakeAcpAgent.mjs');

// Raw agent: RAW_MODE=no-init (never answers) | bad-version | exit-after-init (leader exits, children stay) | ok. RAW_IGNORE_TERM=1 ignores SIGTERM.
// RAW_GRANDCHILD=1 starts `sleep 30` and prints its pid to stderr.
const RAW_AGENT = `
const { spawn } = require('node:child_process');
const mode = process.env.RAW_MODE || 'ok';
if (process.env.RAW_IGNORE_TERM) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
if (process.env.RAW_GRANDCHILD) {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' });
  process.stderr.write('GRANDCHILD ' + c.pid + '\\n');
}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(m) {
  if (m.method === 'initialize') {
    if (mode === 'no-init') return;
    send({ id: m.id, result: { protocolVersion: mode === 'bad-version' ? 99 : 1, agentCapabilities: {} } });
    if (mode === 'exit-after-init') setTimeout(() => process.exit(0), 50);
  } else if (m.id !== undefined) {
    send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
}
`;

let dir: string;
const conns: AcpConnection[] = [];

function tmp(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'hopecode-acpconn-'));
  return dir;
}

function rawSpec(env: Record<string, string> = {}): AcpLaunchSpec {
  const path = join(tmp(), 'rawAgent.cjs');
  writeFileSync(path, RAW_AGENT);
  return { command: process.execPath, args: [path], env: { PATH: process.env.PATH ?? '', ...env } };
}

function fakeSpec(profile: 'codex' | 'hermes' = 'codex'): AcpLaunchSpec {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { PATH: process.env.PATH ?? '', FAKE_ACP_PROFILE: profile, FAKE_ACP_STATE_DIR: join(tmp(), 'state') },
  };
}

function open(spec: AcpLaunchSpec, updates: SessionNotification[] = []) {
  const conn = new AcpConnection({
    spec,
    cwd: tmp(),
    appVersion: '0.0.0-test',
    handlers: {
      onUpdate: (n) => updates.push(n),
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    },
  });
  conns.push(conn);
  return conn;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(async () => {
  for (const c of conns.splice(0)) c.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

describe('AcpConnection', () => {
  it('initialize -> session/new -> prompt; updates sent before the response are delivered first', async () => {
    const updates: SessionNotification[] = [];
    const conn = open(fakeSpec(), updates);
    const init = await conn.initialize();
    expect(init.agentInfo?.name).toBe('@agentclientprotocol/codex-acp');
    expect(conn.init).toBe(init);
    const { sessionId } = await conn.request('session/new', { cwd: tmp(), mcpServers: [] }, 5000);
    const res = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello world' }] }, null);
    expect(res.stopReason).toBe('end_turn');
    const text = updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.content.type === 'text' ? u.content.text : ''))
      .join('');
    expect(text).toBe('FAKE-ACP(codex): hello world');
  });

  it('times out a request (the SDK has no timeout) and rejects an aborted one', async () => {
    const conn = open(rawSpec({ RAW_MODE: 'no-init' }));
    await expect(conn.initialize(undefined, 150)).rejects.toBeInstanceOf(AcpTimeoutError);
    const abort = new AbortController();
    const p = conn.initialize(abort.signal, 10_000);
    abort.abort();
    await expect(p).rejects.toBeInstanceOf(AcpAbortedError);
  });

  it('rejects a protocol version other than 1', async () => {
    const conn = open(rawSpec({ RAW_MODE: 'bad-version' }));
    await expect(conn.initialize()).rejects.toBeInstanceOf(AcpProtocolVersionError);
  });

  it('spawn ENOENT / EACCES become AcpSpawnError (no uncaught error)', async () => {
    const missing = open({ command: join(tmp(), 'does-not-exist'), args: [], env: {} });
    await expect(missing.initialize()).rejects.toMatchObject({ name: 'AcpSpawnError', code: 'ENOENT' });
    expect(missing.isGone).toBe(true);
    await missing.exited;

    const noExec = join(tmp(), 'not-executable');
    writeFileSync(noExec, '#!/bin/sh\nexit 0\n');
    chmodSync(noExec, 0o644);
    const denied = open({ command: noExec, args: [], env: {} });
    const err = await denied.initialize().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpSpawnError);
    expect(['EACCES', 'EPERM']).toContain((err as AcpSpawnError).code);
  });

  it('stdin EPIPE is handled as the agent being gone', async () => {
    // The shell closes its stdin and keeps running: our writes hit EPIPE.
    const conn = open({ command: '/bin/sh', args: ['-c', 'exec 0<&-; sleep 5'], env: { PATH: process.env.PATH ?? '' } });
    await new Promise((r) => setTimeout(r, 200));
    const err = await conn.initialize(undefined, 3000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AcpTimeoutError);
    await waitFor(() => conn.isGone);
  });

  it('crash rejects the pending prompt with a redacted stderr tail', async () => {
    const conn = open(fakeSpec());
    await conn.initialize();
    const { sessionId } = await conn.request('session/new', { cwd: tmp(), mcpServers: [] }, 5000);
    const err = await conn
      .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/crash' }] }, null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpProcessExitedError);
    const exited = err as AcpProcessExitedError;
    expect(exited.code).toBe(1);
    expect(exited.stderrTail).toContain('fatal: token');
    expect(exited.stderrTail).not.toContain('sk-FAKESECRET0123456789');
    expect(conn.stderrTail()).not.toContain('FAKESECRET0123456789');
  });

  it('kill() takes down the whole process group (no grandchild left)', async () => {
    const conn = open(rawSpec({ RAW_GRANDCHILD: '1' }));
    await conn.initialize();
    await waitFor(() => /GRANDCHILD \d+/.test(conn.stderrTail()));
    const grandchild = Number(/GRANDCHILD (\d+)/.exec(conn.stderrTail())![1]);
    expect(alive(grandchild)).toBe(true);
    conn.kill();
    await conn.exited;
    await waitFor(() => !alive(grandchild));
  });

  it('close() sends session/close when supported, then the process exits', async () => {
    const conn = open(fakeSpec('codex'));
    await conn.initialize();
    const { sessionId } = await conn.request('session/new', { cwd: tmp(), mcpServers: [] }, 5000);
    await conn.close({ sessionId });
    expect(conn.isGone).toBe(true);
    const info = await conn.exited;
    expect(info.code === 0 || info.signal !== null).toBe(true);
  });

  it('dispose close skips session/close and finishes within the budget even when SIGTERM is ignored', async () => {
    const conn = open(rawSpec({ RAW_IGNORE_TERM: '1', RAW_GRANDCHILD: '1' }));
    await conn.initialize();
    await waitFor(() => /GRANDCHILD \d+/.test(conn.stderrTail()));
    const grandchild = Number(/GRANDCHILD (\d+)/.exec(conn.stderrTail())![1]);
    const started = Date.now();
    await conn.close({ sessionId: 'raw', dispose: true });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThanOrEqual(ACP_DISPOSE_BUDGET_MS + 150);
    expect((await conn.exited).signal).toBe('SIGKILL');
    await waitFor(() => !alive(grandchild));
  });

  it('normal close escalates to SIGKILL after the grace period', async () => {
    const conn = new AcpConnection({
      spec: rawSpec({ RAW_IGNORE_TERM: '1' }),
      cwd: tmp(),
      appVersion: '0.0.0-test',
      killGraceMs: 200,
      handlers: { onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
    });
    conns.push(conn);
    await conn.initialize();
    await conn.close();
    expect((await conn.exited).signal).toBe('SIGKILL');
  });

  it('leader exit: its leftover group is signalled once at exit; later close() / kill() never signal the (reusable) pid', async () => {
    const signals: string[] = [];
    const conn = new AcpConnection({
      spec: rawSpec({ RAW_MODE: 'exit-after-init', RAW_GRANDCHILD: '1' }),
      cwd: tmp(),
      appVersion: '0.0.0-test',
      killGroup: (pid, sig) => {
        signals.push(sig);
        try {
          process.kill(-pid, sig);
          return true;
        } catch {
          return false;
        }
      },
      handlers: { onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
    });
    conns.push(conn);
    await conn.initialize();
    await waitFor(() => /GRANDCHILD \d+/.test(conn.stderrTail()));
    const grandchild = Number(/GRANDCHILD (\d+)/.exec(conn.stderrTail())![1]);
    await conn.exited;
    await waitFor(() => !alive(grandchild));
    await new Promise((r) => setTimeout(r, 700)); // past the exit grace
    const atExit = [...signals];
    expect(atExit[0]).toBe('SIGTERM');
    conn.kill();
    await conn.close();
    expect(signals).toEqual(atExit);
  });

  it('close() / kill() after the leader exited: the grandchild is gone (cleared at exit)', async () => {
    for (const how of ['close', 'kill'] as const) {
      const conn = new AcpConnection({
        spec: rawSpec({ RAW_MODE: 'exit-after-init', RAW_GRANDCHILD: '1' }),
        cwd: tmp(),
        appVersion: '0.0.0-test',
        killGraceMs: 100,
        handlers: { onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
      });
      conns.push(conn);
      await conn.initialize();
      await waitFor(() => /GRANDCHILD \d+/.test(conn.stderrTail()));
      const grandchild = Number(/GRANDCHILD (\d+)/.exec(conn.stderrTail())![1]);
      await conn.exited;
      expect(alive(grandchild)).toBe(true);
      if (how === 'close') await conn.close();
      else conn.kill();
      await waitFor(() => !alive(grandchild));
    }
  });

  it('stderrTail caps very long lines', async () => {
    const conn = open({ command: '/bin/sh', args: ['-c', "head -c 10000 /dev/zero | tr '\\0' x >&2; echo >&2; sleep 5"], env: { PATH: process.env.PATH ?? '' } });
    await waitFor(() => conn.stderrTail().length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.stderrTail()).toBe(`${'x'.repeat(4 * 1024)}…`);
  });
});
