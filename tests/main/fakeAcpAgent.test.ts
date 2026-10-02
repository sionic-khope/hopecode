// Protocol sanity of the fixture ACP agent (plan 4, Lane D): talks to it with the real SDK client over stdio.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAcpFixtureLauncher, FIXTURE_CODEX_PATH } from '../../src/main/fixtures/acpFixtureLaunchers';

const SCRIPT = resolve(__dirname, '../fixtures/acp/fakeAcpAgent.mjs');

type Update = Record<string, any> & { sessionUpdate: string };
type PermissionPick = 'first-allow' | string | 'cancel';

interface Harness {
  child: ChildProcess;
  conn: acp.ClientConnection;
  updates: Update[];
  permissionRequests: acp.RequestPermissionRequest[];
  stderr: () => string;
  setPermission(pick: PermissionPick): void;
  req<T = any>(method: string, params: unknown): Promise<T>;
  close(): void;
}

describe('fakeAcpAgent', () => {
  let dir: string;
  let stateDir: string;
  let cwd: string;
  const live: Harness[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fake-acp-'));
    stateDir = join(dir, 'state');
    cwd = join(dir, 'cwd');
    await import('node:fs/promises').then((fs) => fs.mkdir(cwd));
  });
  afterEach(async () => {
    for (const h of live.splice(0)) h.close();
    await rm(dir, { recursive: true, force: true });
  });

  function start(profile: 'codex' | 'hermes' | 'noload', extra: { args?: string[]; env?: Record<string, string> } = {}): Harness {
    const child = spawn(process.execPath, [SCRIPT, ...(extra.args ?? [])], {
      cwd,
      env: { ...process.env, FAKE_ACP_PROFILE: profile, FAKE_ACP_STATE_DIR: stateDir, ...extra.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr!.on('data', (d) => (err += String(d)));
    const updates: Update[] = [];
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    let pick: PermissionPick = 'first-allow';
    const conn = acp
      .client({ name: 'fake-test' })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        updates.push(ctx.params.update as Update);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        permissionRequests.push(ctx.params);
        if (pick === 'cancel') return { outcome: { outcome: 'cancelled' as const } };
        const opt = pick === 'first-allow' ? ctx.params.options.find((o) => o.kind.startsWith('allow')) : ctx.params.options.find((o) => o.optionId === pick);
        return { outcome: { outcome: 'selected' as const, optionId: opt!.optionId } };
      })
      .connect(acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
    const h: Harness = {
      child,
      conn,
      updates,
      permissionRequests,
      stderr: () => err,
      setPermission: (p) => (pick = p),
      req: (method, params) => conn.agent.request(method as any, params as any) as Promise<any>,
      close: () => {
        child.kill('SIGKILL');
      },
    };
    live.push(h);
    return h;
  }

  async function open(h: Harness) {
    const init = await h.req('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const created = await h.req('session/new', { cwd, mcpServers: [] });
    return { init, created, sessionId: created.sessionId as string };
  }
  const prompt = (h: Harness, sessionId: string, text: string, extra: unknown[] = []) =>
    h.req('session/prompt', { sessionId, prompt: [{ type: 'text', text }, ...extra] });
  const texts = (h: Harness) =>
    h.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text as string).join('');

  describe('codex profile', () => {
    it('initialize / new report capabilities, modes and configOptions', async () => {
      const h = start('codex');
      const { init, created } = await open(h);
      expect(init.agentCapabilities.loadSession).toBe(true);
      expect(init.agentCapabilities.promptCapabilities.image).toBe(true);
      expect(init.agentCapabilities.sessionCapabilities.close).toBeDefined();
      expect(init.agentInfo.name).toBe('@agentclientprotocol/codex-acp');
      // No INITIAL_AGENT_MODE: the adapter's own default (Auto review), which deltax never relies on.
      expect(created.modes.currentModeId).toBe('agent');
      expect(created.modes.availableModes.map((m: any) => m.id)).toEqual(['read-only', 'workspace-write', 'agent', 'agent-full-access']);
      expect(created.configOptions.map((o: any) => [o.id, o.category])).toEqual([
        ['mode', 'mode'],
        ['collaboration_mode', 'collaboration_mode'],
        ['model', 'model'],
        ['reasoning_effort', 'thought_level'],
        ['fast-mode', 'model_config'],
      ]);
      const byId = Object.fromEntries(created.configOptions.map((o: any) => [o.id, o]));
      expect(byId.model.category).toBe('model');
      expect(byId.model.currentValue).toBe('gpt-6-sol');
      expect(byId.reasoning_effort.category).toBe('thought_level');
      expect(byId.reasoning_effort.currentValue).toBe('medium');
    });

    it('reflects CODEX_CONFIG / INITIAL_AGENT_MODE / CODEX_PATH in [whoami], /config and the initial mode', async () => {
      const h = start('codex', {
        env: {
          CODEX_CONFIG: JSON.stringify({ model: 'gpt-6.1-sol', model_reasoning_effort: 'max' }),
          INITIAL_AGENT_MODE: 'agent-full-access',
          CODEX_PATH: '/x/codex',
        },
      });
      const { created, sessionId } = await open(h);
      expect(created.modes.currentModeId).toBe('agent-full-access');
      expect(created.configOptions.find((o: any) => o.id === 'model').currentValue).toBe('gpt-6.1-sol');
      await prompt(h, sessionId, '[whoami]');
      const who = JSON.parse(texts(h).replace(/^WHOAMI /, ''));
      expect(who).toMatchObject({
        profile: 'codex',
        model: 'gpt-6.1-sol',
        reasoning_effort: 'max',
        approval_policy: 'never',
        sandbox_mode: 'danger-full-access',
        initialMode: 'agent-full-access',
        codexPath: '/x/codex',
        args: [],
      });
      h.updates.length = 0;
      await prompt(h, sessionId, '/config');
      const cfg = JSON.parse(texts(h).replace(/^CONFIG /, ''));
      expect(cfg).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'max', approval_policy: 'never', cwd });
    });

    it('unknown model falls back to gpt-6-sol; no args -> defaults', async () => {
      const h = start('codex', { env: { CODEX_CONFIG: '{"model":"made-up"}', INITIAL_AGENT_MODE: 'bogus' } });
      const { created } = await open(h);
      expect(created.configOptions.find((o: any) => o.id === 'model').currentValue).toBe('gpt-6-sol');
      expect(created.modes.currentModeId).toBe('agent');
    });

    it('set_config_option updates and returns configOptions; bad value is an error', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      const res = await h.req('session/set_config_option', { sessionId, configId: 'model', value: 'gpt-6.1-sol' });
      expect(res.configOptions.find((o: any) => o.id === 'model').currentValue).toBe('gpt-6.1-sol');
      await expect(h.req('session/set_config_option', { sessionId, configId: 'model', value: 'nope' })).rejects.toThrow();
      await prompt(h, sessionId, '/config');
      expect(texts(h)).toContain('"configSets":[{"configId":"model","value":"gpt-6.1-sol"},{"configId":"model","value":"nope"}]');
    });

    it('set_mode changes the mode and rejects unknown ids', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      await h.req('session/set_mode', { sessionId, modeId: 'read-only' });
      await prompt(h, sessionId, '/config');
      expect(texts(h)).toContain('"modeId":"read-only"');
      await expect(h.req('session/set_mode', { sessionId, modeId: 'zzz' })).rejects.toThrow();
    });

    it('default echo streams 3-5 chunks then end_turn', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      const res = await prompt(h, sessionId, 'hello world');
      expect(res.stopReason).toBe('end_turn');
      const chunks = h.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk');
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks.length).toBeLessThanOrEqual(5);
      expect(texts(h)).toBe('FAKE-ACP(codex): hello world');
      expect(h.updates.some((u) => u.sessionUpdate === 'usage_update')).toBe(false);
    });

    it('/tool: pending -> in_progress -> completed(content) -> text', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      await prompt(h, sessionId, '/tool');
      const seq = h.updates.map((u) => `${u.sessionUpdate}:${u.status ?? ''}`);
      expect(seq).toEqual(['tool_call:pending', 'tool_call_update:in_progress', 'tool_call_update:completed', 'agent_message_chunk:']);
      expect(h.updates[0]).toMatchObject({ kind: 'read' });
      expect(h.updates[2]!.content[0].content.text).toContain('fixture tool output');
    });

    it('/diff writes fake-acp-edit.txt in cwd and reports a diff', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      await prompt(h, sessionId, '/diff');
      const file = join(cwd, 'fake-acp-edit.txt');
      expect(existsSync(file)).toBe(true);
      expect(h.updates[0]).toMatchObject({ sessionUpdate: 'tool_call', kind: 'edit' });
      const done = h.updates[1]!;
      expect(done.status).toBe('completed');
      expect(done.content[0]).toMatchObject({ type: 'diff', path: file, newText: readFileSync(file, 'utf8') });
      expect(done.content[0].oldText ?? null).toBeNull();
      h.updates.length = 0;
      await prompt(h, sessionId, '/diff');
      expect(h.updates[1]!.content[0].oldText).toContain('fake acp edit 1');
    });

    it('/permission: allow -> completed, reject -> failed, cancelled -> stopReason cancelled', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      let res = await prompt(h, sessionId, '/permission');
      expect(res.stopReason).toBe('end_turn');
      expect(h.permissionRequests[0]!.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
      expect(h.updates.filter((u) => u.sessionUpdate === 'tool_call_update').at(-1)!.status).toBe('completed');

      h.updates.length = 0;
      h.setPermission('reject_once');
      res = await prompt(h, sessionId, '/permission');
      expect(res.stopReason).toBe('end_turn');
      expect(h.updates.filter((u) => u.sessionUpdate === 'tool_call_update').at(-1)!.status).toBe('failed');

      h.updates.length = 0;
      h.setPermission('cancel');
      res = await prompt(h, sessionId, '/permission');
      expect(res.stopReason).toBe('cancelled');
    });

    it('/plan sends 3 pending entries then progresses to completed', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      await prompt(h, sessionId, '/plan');
      const plans = h.updates.filter((u) => u.sessionUpdate === 'plan');
      expect(plans[0]!.entries.map((e: any) => e.status)).toEqual(['pending', 'pending', 'pending']);
      expect(plans[1]!.entries.map((e: any) => e.status)).toEqual(['in_progress', 'pending', 'pending']);
      expect(plans.at(-1)!.entries.map((e: any) => e.status)).toEqual(['completed', 'completed', 'completed']);
    });

    it('/slow keeps streaming until session/cancel, then returns cancelled', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      const p = prompt(h, sessionId, '/slow');
      await new Promise((r) => setTimeout(r, 700));
      expect(h.updates.length).toBeGreaterThanOrEqual(2);
      await h.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId });
      expect((await p).stopReason).toBe('cancelled');
    });

    it('/crash emits one chunk, a fake secret on stderr and exits 1', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      const exited = new Promise<number | null>((r) => h.child.once('exit', (code) => r(code)));
      const p = prompt(h, sessionId, '/crash').catch((e) => e);
      expect(await exited).toBe(1);
      await p;
      expect(h.stderr()).toContain('fatal: token sk-FAKESECRET0123456789');
      expect(h.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk')).toHaveLength(1);
    });

    it('/mode sends current_mode_update and config_option_update', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      await prompt(h, sessionId, '/mode');
      // agent (the default) -> agent-full-access
      expect(h.updates.find((u) => u.sessionUpdate === 'current_mode_update')).toMatchObject({ currentModeId: 'agent-full-access' });
      const cfg = h.updates.find((u) => u.sessionUpdate === 'config_option_update')!;
      expect(cfg.configOptions.map((o: any) => o.id)).toEqual(['mode', 'collaboration_mode', 'model', 'reasoning_effort', 'fast-mode']);
      expect(cfg.configOptions[0].currentValue).toBe('agent-full-access');
      h.updates.length = 0;
      await prompt(h, sessionId, '/mode workspace-write');
      expect(h.updates.find((u) => u.sessionUpdate === 'current_mode_update')).toMatchObject({ currentModeId: 'workspace-write' });
    });

    it('/image counts image blocks', async () => {
      const h = start('codex');
      const { sessionId } = await open(h);
      await prompt(h, sessionId, '/image', [
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'image', mimeType: 'image/png', data: 'BBBB' },
      ]);
      expect(texts(h)).toBe('images: 2');
    });

    it('load replays user and agent chunks from the state dir (new process)', async () => {
      const a = start('codex');
      const { sessionId } = await open(a);
      await prompt(a, sessionId, 'remember me');
      a.close();

      const b = start('codex');
      await b.req('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const res = await b.req('session/load', { sessionId, cwd, mcpServers: [] });
      expect(res.modes.currentModeId).toBe('agent');
      expect(b.updates.map((u) => u.sessionUpdate)).toEqual(['user_message_chunk', 'agent_message_chunk']);
      expect(b.updates[0]!.content.text).toBe('remember me');
      expect(b.updates[1]!.content.text).toBe('FAKE-ACP(codex): remember me');
      await expect(b.req('session/load', { sessionId: 'fake-missing', cwd, mcpServers: [] })).rejects.toThrow();
    });

    it('FAKE_ACP_AUTH_REQUIRED=1: session/new fails with -32000', async () => {
      const h = start('codex', { env: { FAKE_ACP_AUTH_REQUIRED: '1' } });
      await h.req('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      await expect(h.req('session/new', { cwd, mcpServers: [] })).rejects.toMatchObject({ code: -32000 });
    });
  });

  describe('hermes profile', () => {
    it('new response has models + modes + field_meta and no configOptions', async () => {
      const h = start('hermes');
      const { init, created } = await open(h);
      expect(init.agentCapabilities.sessionCapabilities.close).toBeUndefined();
      expect(created.models.currentModelId).toBe('og/deepseek-fixture');
      expect(created.modes.currentModeId).toBe('default');
      expect(created.modes.availableModes.map((m: any) => m.id)).toEqual(['default', 'accept_edits', 'dont_ask']);
      expect(created.field_meta).toBeDefined();
      expect('configOptions' in created).toBe(false);
    });

    it('FAKE_ACP_NO_MODELS=1 omits models', async () => {
      const h = start('hermes', { env: { FAKE_ACP_NO_MODELS: '1' } });
      const { created } = await open(h);
      expect('models' in created).toBe(false);
      expect(created.modes).toBeDefined();
    });

    it('load of an unknown id resolves to {} (null through the SDK); a known id replays and returns modes', async () => {
      const h = start('hermes');
      const { sessionId } = await open(h);
      await prompt(h, sessionId, 'hi');
      h.updates.length = 0;
      expect(await h.req('session/load', { sessionId: 'fake-missing', cwd, mcpServers: [] })).toEqual({});
      expect(h.updates).toHaveLength(0);
      const ok = await h.req('session/load', { sessionId, cwd, mcpServers: [] });
      expect(ok.modes.currentModeId).toBe('default');
      expect(ok.models.currentModelId).toBe('og/deepseek-fixture');
      expect(h.updates.map((u) => u.sessionUpdate)).toEqual(['user_message_chunk', 'agent_message_chunk']);
    });

    it('resume of an unknown id creates a session instead of failing', async () => {
      const h = start('hermes');
      await h.req('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const res = await h.req('session/resume', { sessionId: 'fake-new-one', cwd, mcpServers: [] });
      expect(res.modes).toBeDefined();
    });

    it('set_config_option returns [] and is recorded for /config', async () => {
      const h = start('hermes');
      const { sessionId } = await open(h);
      expect(await h.req('session/set_config_option', { sessionId, configId: 'model', value: 'x' })).toEqual({ configOptions: [] });
      await prompt(h, sessionId, '/config');
      expect(texts(h)).toContain('"configSets":[{"configId":"model","value":"x"}]');
      expect(texts(h)).toContain('og/deepseek-fixture');
    });

    it('permission options follow the real Hermes kinds', async () => {
      const h = start('hermes');
      const { sessionId } = await open(h);
      h.setPermission('allow_session');
      await prompt(h, sessionId, '/permission');
      expect(h.permissionRequests[0]!.options.map((o) => `${o.optionId}:${o.kind}`)).toEqual([
        'allow_once:allow_once',
        'allow_session:allow_always',
        'allow_always:allow_always',
        'deny:reject_once',
        'deny_always:reject_always',
      ]);
      expect(texts(h)).toBe('permission: allow_session');
    });

    it('sends usage_update every turn', async () => {
      const h = start('hermes');
      const { sessionId } = await open(h);
      await prompt(h, sessionId, 'hi');
      expect(h.updates.at(-1)).toMatchObject({ sessionUpdate: 'usage_update', size: 128000 });
    });

    it('/mode cycles the hermes modes and sends an empty config_option_update', async () => {
      const h = start('hermes');
      const { sessionId } = await open(h);
      await prompt(h, sessionId, '/mode');
      expect(h.updates.find((u) => u.sessionUpdate === 'current_mode_update')).toMatchObject({ currentModeId: 'accept_edits' });
      expect(h.updates.find((u) => u.sessionUpdate === 'config_option_update')!.configOptions).toEqual([]);
    });
  });

  describe('noload profile', () => {
    it('does not support loadSession and has no resume/close', async () => {
      const h = start('noload');
      const { init, sessionId } = await open(h);
      expect(init.agentCapabilities.loadSession).toBe(false);
      expect(init.agentCapabilities.sessionCapabilities).toBeUndefined();
      await expect(h.req('session/load', { sessionId, cwd, mcpServers: [] })).rejects.toThrow();
      expect((await prompt(h, sessionId, 'hi')).stopReason).toBe('end_turn');
    });
  });

  describe('launcher', () => {
    it('builds argv/env for each profile and honours unavailable', async () => {
      const base = { scriptPath: SCRIPT, stateDir };
      const codex = await createAcpFixtureLauncher({ ...base, profile: 'codex' }).resolve(cwd, { model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'plan', gitCeiling: '/x' });
      expect(codex.ok && codex.spec.args).toEqual([SCRIPT]);
      expect(codex.ok && codex.spec.env).toMatchObject({
        FAKE_ACP_PROFILE: 'codex',
        FAKE_ACP_STATE_DIR: stateDir,
        ELECTRON_RUN_AS_NODE: '1',
        GIT_CEILING_DIRECTORIES: '/x',
        CODEX_PATH: FIXTURE_CODEX_PATH,
        CODEX_CONFIG: '{"model":"gpt-6.1-sol","model_reasoning_effort":"high"}',
        INITIAL_AGENT_MODE: 'read-only',
      });
      const hermes = await createAcpFixtureLauncher({ ...base, profile: 'hermes', env: { FAKE_ACP_NO_MODELS: '1' } }).resolve(cwd, { permissionMode: 'default' });
      expect(hermes.ok && hermes.spec.args).toEqual([SCRIPT]);
      expect(hermes.ok && hermes.spec.env).not.toHaveProperty('INITIAL_AGENT_MODE');
      expect(hermes.ok && hermes.spec.env.FAKE_ACP_NO_MODELS).toBe('1');
      expect(await createAcpFixtureLauncher({ ...base, profile: 'hermes', unavailable: 'not-logged-in' }).resolve(cwd, { permissionMode: 'default' })).toEqual({ ok: false, reason: 'not-logged-in' });
    });
  });
});
