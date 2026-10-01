#!/usr/bin/env node
// Scripted fake ACP agent over stdio (plan 4). Test/e2e only: never packaged, no network access.
// Profile: FAKE_ACP_PROFILE=codex|hermes|noload. Session state (load replay): FAKE_ACP_STATE_DIR/<sessionId>.json.
// Other env: FAKE_ACP_NO_MODELS=1 (hermes omits `models`), FAKE_ACP_AUTH_REQUIRED=1 (session/new -> -32000),
// FAKE_ACP_INIT_DELAY_MS=<ms> (initialize answers late), FAKE_ACP_SET_MODE_FAIL=1 (session/set_mode errors).
// Prompt scenarios (first word): /tool /diff /permission /plan /slow /crash /mode /image /config; `[whoami]` anywhere.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const PROFILE = ['codex', 'hermes', 'noload'].includes(process.env.FAKE_ACP_PROFILE) ? process.env.FAKE_ACP_PROFILE : 'codex';
const STATE_DIR = process.env.FAKE_ACP_STATE_DIR || null;
const NO_MODELS = process.env.FAKE_ACP_NO_MODELS === '1';
const AUTH_REQUIRED = process.env.FAKE_ACP_AUTH_REQUIRED === '1';
const INIT_DELAY_MS = Number(process.env.FAKE_ACP_INIT_DELAY_MS || 0);
const SET_MODE_FAILS = process.env.FAKE_ACP_SET_MODE_FAIL === '1';
const IS_HERMES = PROFILE === 'hermes';

// ---- argv: `-c key=value` (codex-acp style config overrides) --------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const kv = a === '-c' || a === '--config' ? argv[++i] : a.startsWith('-c=') ? a.slice(3) : null;
    if (typeof kv !== 'string') continue;
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    let v = kv.slice(eq + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[kv.slice(0, eq).trim()] = v;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

// ---- profile data ----------------------------------------------------------------------------------------------
const CODEX_MODELS = ['gpt-6-sol', 'gpt-6.1-sol'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// codex-acp's "Approval Preset" select (category `mode`): the app must never set it (it can mean full access).
const CODEX_PRESETS = ['read-only', 'auto', 'full-access'];
const CODEX_MODES = [
  { id: 'read-only', name: 'Read Only', description: 'Read files only' },
  { id: 'auto', name: 'Default', description: 'Edit in the workspace, ask for the rest' },
  { id: 'full-access', name: 'Full Access', description: 'No sandbox, no approvals' },
];
const HERMES_MODES = [
  { id: 'default', name: 'Ask before edits', description: 'Ask before every edit' },
  { id: 'accept_edits', name: 'Accept edits', description: 'Edits are applied without asking' },
  { id: 'dont_ask', name: "Don't ask", description: 'Never ask for permission' },
];
const HERMES_MODEL = 'og/deepseek-fixture';

function initialModes() {
  if (IS_HERMES) return { available: HERMES_MODES, current: 'default' };
  if (PROFILE === 'noload') return { available: CODEX_MODES, current: 'auto' };
  const current = ARGS.sandbox_mode === 'read-only' ? 'read-only' : ARGS.sandbox_mode === 'danger-full-access' ? 'full-access' : 'auto';
  return { available: CODEX_MODES, current };
}

const sessions = new Map();

function newState(sessionId, cwd) {
  const m = initialModes();
  return {
    sessionId,
    cwd,
    history: [], // {role:'user'|'agent', text}
    modeId: m.current,
    model: CODEX_MODELS.includes(ARGS.model) ? ARGS.model : 'gpt-6-sol',
    effort: CODEX_EFFORTS.includes(ARGS.model_reasoning_effort) ? ARGS.model_reasoning_effort : 'medium',
    configSets: [], // received session/set_config_option calls
    turn: 0,
  };
}

function save(s) {
  if (!STATE_DIR) return;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `${s.sessionId}.json`), JSON.stringify(s));
}

function loadState(sessionId) {
  const mem = sessions.get(sessionId);
  if (mem) return mem;
  if (!STATE_DIR || !/^[\w-]+$/.test(sessionId)) return null;
  const file = join(STATE_DIR, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    sessions.set(sessionId, s);
    return s;
  } catch {
    return null;
  }
}

function modesOf(s) {
  const m = initialModes();
  return { currentModeId: s.modeId, availableModes: m.available };
}

function configOptionsOf(s) {
  if (IS_HERMES) return undefined; // Hermes sends no configOptions
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: s.model,
      options: CODEX_MODELS.map((value) => ({ value, name: value })),
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: s.effort,
      options: CODEX_EFFORTS.map((value) => ({ value, name: value })),
    },
    {
      id: 'approval_preset',
      name: 'Approval Preset',
      category: 'mode',
      type: 'select',
      currentValue: s.modeId,
      options: CODEX_PRESETS.map((value) => ({ value, name: value })),
    },
  ];
}

/** Response fields shared by new / load / resume (Hermes real shape: models + modes + field_meta, no configOptions). */
function sessionFields(s) {
  if (IS_HERMES) {
    return {
      ...(NO_MODELS
        ? {}
        : {
            models: {
              currentModelId: HERMES_MODEL,
              availableModels: [{ modelId: HERMES_MODEL, name: 'DeepSeek (fixture)' }],
            },
          }),
      modes: modesOf(s),
      field_meta: { fixture: true },
    };
  }
  return { modes: modesOf(s), configOptions: configOptionsOf(s) };
}

// ---- helpers ---------------------------------------------------------------------------------------------------
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const prompts = new Map(); // sessionId -> AbortController of the running prompt

function textOf(blocks) {
  return (blocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function whoami(s) {
  return `WHOAMI ${JSON.stringify({
    profile: PROFILE,
    sessionId: s.sessionId,
    cwd: s.cwd,
    processCwd: process.cwd(),
    model: s.model,
    reasoning_effort: s.effort,
    modeId: s.modeId,
    approval_policy: ARGS.approval_policy ?? null,
    sandbox_mode: ARGS.sandbox_mode ?? null,
    args: ARGS,
  })}`;
}

const permissionOptions = IS_HERMES
  ? [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
      { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      { optionId: 'deny_always', name: 'Deny always', kind: 'reject_always' },
    ]
  : [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ];

// ---- prompt turn -----------------------------------------------------------------------------------------------
async function runTurn(s, params, cx, signal) {
  const { sessionId } = params;
  const text = textOf(params.prompt);
  const images = (params.prompt ?? []).filter((b) => b.type === 'image').length;
  s.turn += 1;
  const messageId = randomUUID();
  let agentText = '';
  let toolSeq = 0;

  const update = (u) => cx.client.notify(acp.methods.client.session.update, { sessionId, update: u });
  const say = async (chunk) => {
    agentText += chunk;
    await update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: chunk } });
  };
  const toolId = () => `tool-${s.turn}-${++toolSeq}`;
  const finish = async (stopReason = 'end_turn') => {
    if (IS_HERMES) await update({ sessionUpdate: 'usage_update', used: 1000 * s.turn, size: 128000 });
    s.history.push({ role: 'agent', text: agentText });
    save(s);
    return { stopReason };
  };

  s.history.push({ role: 'user', text });
  const word = text.trim().split(/\s+/)[0] ?? '';

  if (text.includes('[whoami]')) {
    await say(whoami(s));
    return finish();
  }

  switch (word) {
    case '/tool': {
      const id = toolId();
      await update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Read README.md', kind: 'read', status: 'pending', locations: [{ path: join(s.cwd, 'README.md') }], rawInput: { path: 'README.md' } });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '# fake README\nfixture tool output' } }] });
      await say('tool done');
      return finish();
    }
    case '/diff': {
      const id = toolId();
      const path = join(s.cwd, 'fake-acp-edit.txt');
      const oldText = existsSync(path) ? readFileSync(path, 'utf8') : null;
      const newText = `fake acp edit ${s.turn}\n`;
      await update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Edit fake-acp-edit.txt', kind: 'edit', status: 'pending', locations: [{ path }], rawInput: { path } });
      writeFileSync(path, newText);
      await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'diff', path, oldText, newText }] });
      await say('edit done');
      return finish();
    }
    case '/permission': {
      const id = toolId();
      const toolCall = { toolCallId: id, title: 'Run echo fixture', kind: 'execute', status: 'pending', rawInput: { command: 'echo fixture' } };
      await update({ sessionUpdate: 'tool_call', ...toolCall });
      const cancelled = new Promise((resolve) => {
        if (signal.aborted) resolve({ outcome: { outcome: 'cancelled' } });
        signal.addEventListener('abort', () => resolve({ outcome: { outcome: 'cancelled' } }), { once: true });
      });
      const res = await Promise.race([
        cx.client.request(acp.methods.client.session.requestPermission, { sessionId, toolCall, options: permissionOptions }),
        cancelled,
      ]);
      if (res.outcome.outcome !== 'selected') {
        await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' });
        return finish('cancelled');
      }
      const picked = permissionOptions.find((o) => o.optionId === res.outcome.optionId);
      const allowed = picked?.kind.startsWith('allow') ?? false;
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: allowed ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: allowed ? 'fixture' : 'rejected' } }],
      });
      await say(`permission: ${res.outcome.optionId}`);
      return finish();
    }
    case '/plan': {
      const steps = ['Inspect', 'Change', 'Verify'];
      const entries = (done) => steps.map((content, i) => ({ content, priority: 'medium', status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }));
      await update({ sessionUpdate: 'plan', entries: steps.map((content) => ({ content, priority: 'medium', status: 'pending' })) });
      for (let done = 0; done < steps.length; done++) {
        await update({ sessionUpdate: 'plan', entries: entries(done) });
      }
      await update({ sessionUpdate: 'plan', entries: entries(steps.length) });
      await say('plan done');
      return finish();
    }
    case '/slow': {
      for (let i = 0; i < 300 && !signal.aborted; i++) {
        await say(`tick ${i} `);
        await sleep(200, signal);
      }
      return finish(signal.aborted ? 'cancelled' : 'end_turn');
    }
    case '/crash': {
      await say('about to crash');
      await new Promise((resolve) => process.stderr.write('fatal: token sk-FAKESECRET0123456789\n', resolve));
      await sleep(50);
      process.exit(1);
      return finish();
    }
    case '/mode': {
      const list = initialModes().available;
      const next = list[(list.findIndex((m) => m.id === s.modeId) + 1) % list.length].id;
      s.modeId = next;
      await update({ sessionUpdate: 'current_mode_update', currentModeId: next });
      await update({ sessionUpdate: 'config_option_update', configOptions: configOptionsOf(s) ?? [] });
      await say(`mode: ${next}`);
      return finish();
    }
    case '/image': {
      await say(`images: ${images}`);
      return finish();
    }
    case '/config': {
      await say(
        `CONFIG ${JSON.stringify({
          profile: PROFILE,
          cwd: s.cwd,
          model: IS_HERMES ? HERMES_MODEL : s.model,
          reasoning_effort: IS_HERMES ? null : s.effort,
          modeId: s.modeId,
          approval_policy: ARGS.approval_policy ?? null,
          sandbox_mode: ARGS.sandbox_mode ?? null,
          configSets: s.configSets,
        })}`,
      );
      return finish();
    }
    default: {
      const full = `FAKE-ACP(${PROFILE}): ${text}`;
      const parts = Math.min(5, Math.max(3, Math.ceil(full.length / 12)));
      const size = Math.ceil(full.length / parts);
      for (let i = 0; i < full.length; i += size) {
        if (signal.aborted) return finish('cancelled');
        await say(full.slice(i, i + size));
      }
      return finish();
    }
  }
}

// ---- agent -----------------------------------------------------------------------------------------------------
function requireSession(sessionId) {
  const s = loadState(sessionId);
  if (!s) throw new acp.RequestError(-32602, `Session ${sessionId} not found`);
  return s;
}

const app = acp.agent({ name: `fake-acp-${PROFILE}` });

app.onRequest('initialize', async () => {
  if (INIT_DELAY_MS > 0) await sleep(INIT_DELAY_MS);
  const base = { protocolVersion: acp.PROTOCOL_VERSION };
  if (IS_HERMES) {
    return {
      ...base,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } },
      authMethods: [{ id: 'custom', name: 'custom runtime credentials' }],
      agentInfo: { name: 'hermes-agent', version: '0.0.0-fixture' },
    };
  }
  if (PROFILE === 'noload') {
    return { ...base, agentCapabilities: { loadSession: false, promptCapabilities: { image: true } }, agentInfo: { name: 'fake-noload', version: '0.0.0-fixture' } };
  }
  return {
    ...base,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      sessionCapabilities: { resume: {}, close: {} },
    },
    authMethods: [{ id: 'chatgpt', name: 'Login with ChatGPT' }],
    agentInfo: { name: 'codex-acp', title: 'Codex', version: '0.0.0-fixture' },
  };
});

app.onRequest('authenticate', () => ({}));

app.onRequest('session/new', ({ params }) => {
  if (AUTH_REQUIRED) throw new acp.RequestError(-32000, 'Authentication required');
  const s = newState(`fake-${randomUUID()}`, params.cwd);
  sessions.set(s.sessionId, s);
  save(s);
  return { sessionId: s.sessionId, ...sessionFields(s) };
});

if (PROFILE !== 'noload') {
  app.onRequest('session/load', async ({ params, client }) => {
    if (AUTH_REQUIRED) throw new acp.RequestError(-32000, 'Authentication required');
    const s = loadState(params.sessionId);
    if (!s) {
      if (IS_HERMES) return null; // real Hermes: unknown id -> null (the SDK turns it into {})
      throw new acp.RequestError(-32002, `Session ${params.sessionId} not found`);
    }
    s.cwd = params.cwd;
    for (const h of s.history) {
      await client.notify(acp.methods.client.session.update, {
        sessionId: s.sessionId,
        update: { sessionUpdate: h.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: h.text } },
      });
    }
    return sessionFields(s);
  });

  // Hermes creates the session when resume finds nothing; codex errors.
  app.onRequest('session/resume', ({ params }) => {
    let s = loadState(params.sessionId);
    if (!s) {
      if (!IS_HERMES) throw new acp.RequestError(-32002, `Session ${params.sessionId} not found`);
      s = newState(params.sessionId, params.cwd);
      sessions.set(s.sessionId, s);
      save(s);
    }
    s.cwd = params.cwd;
    return sessionFields(s);
  });
}

if (PROFILE === 'codex') {
  app.onRequest('session/close', ({ params }) => {
    prompts.get(params.sessionId)?.abort();
    return {};
  });
}

app.onRequest('session/set_mode', ({ params }) => {
  if (SET_MODE_FAILS) throw new acp.RequestError(-32603, 'set_mode unavailable');
  const s = requireSession(params.sessionId);
  if (!initialModes().available.some((m) => m.id === params.modeId)) throw new acp.RequestError(-32602, `Unknown mode ${params.modeId}`);
  s.modeId = params.modeId;
  save(s);
  return {};
});

app.onRequest('session/set_config_option', ({ params }) => {
  const s = requireSession(params.sessionId);
  s.configSets.push({ configId: params.configId, value: params.value });
  if (IS_HERMES) {
    save(s);
    return { configOptions: [] }; // real Hermes: accepted, nothing reported back
  }
  if (params.configId === 'model' && CODEX_MODELS.includes(params.value)) s.model = params.value;
  else if (params.configId === 'reasoning_effort' && CODEX_EFFORTS.includes(params.value)) s.effort = params.value;
  else if (params.configId === 'approval_preset' && CODEX_PRESETS.includes(params.value)) s.modeId = params.value;
  else throw new acp.RequestError(-32602, 'Unsupported config option value');
  save(s);
  return { configOptions: configOptionsOf(s) };
});

app.onRequest('session/prompt', async (cx) => {
  const s = requireSession(cx.params.sessionId);
  prompts.get(s.sessionId)?.abort();
  const ac = new AbortController();
  prompts.set(s.sessionId, ac);
  try {
    return await runTurn(s, cx.params, cx, ac.signal);
  } finally {
    if (prompts.get(s.sessionId) === ac) prompts.delete(s.sessionId);
  }
});

app.onNotification('session/cancel', ({ params }) => {
  prompts.get(params.sessionId)?.abort();
});

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
