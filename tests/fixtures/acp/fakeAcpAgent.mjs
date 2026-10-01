#!/usr/bin/env node
// Scripted fake ACP agent over stdio (plan 4). Test/e2e only: never packaged, no network access.
// Profile: FAKE_ACP_PROFILE=codex|hermes|noload. Session state (load replay): FAKE_ACP_STATE_DIR/<sessionId>.json.
// Other env: FAKE_ACP_NO_MODELS=1 (hermes omits `models`), FAKE_ACP_AUTH_REQUIRED=1 (session/new -> -32000),
// FAKE_ACP_INIT_DELAY_MS=<ms> (initialize answers late), FAKE_ACP_SET_MODE_FAIL=1 (session/set_mode errors),
// FAKE_ACP_COMMANDS=1 (an `available_commands_update` right after session/new and session/load).
// Codex (codex-acp 2.x style, env only): CODEX_CONFIG (JSON: model, model_reasoning_effort), INITIAL_AGENT_MODE
// (read-only | workspace-write | agent | agent-full-access; default agent), CODEX_PATH (reported, never run).
// `/mode [modeId]` switches to the next mode (or the given one) from the agent side.
// Prompt scenarios (first word): /tool /slowtool /diff /permission /plan /slow [delayMs] /crash /warn /mode /image
// /blocks /config /media /spawn; `[whoami]` anywhere. /media: an image message chunk, an image generation tool and a
// codex-acp style MCP screenshot (rawOutput.result.content). /spawn: codex-acp legacy collab calls (spawnAgent + wait).
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
const SEND_COMMANDS = process.env.FAKE_ACP_COMMANDS === '1';
/** 48x32 PNG (same as the Claude fixture's FIXTURE_PNG_BASE64). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAA3ElEQVR42u3OTQqCUBTF8bPh9tAqmrWMtlAUhUWRqWlaZp+0hZMgRKDvPQdefQPhN7yH+0f2oVWQvmkVXF60CpInrYL4wRY4w0HNS0R3ysk7yvQThDcKqawpaFYIMkrQ1BRUQ/hXSjAGqYbwUkowBqmGcC9snLGmULnF/kwJxhrVELuEEoxBqiG2MSUYg1RDbE4UoqnRrLCOKKeyRj+BE7INeUq9S6yOtAqWAa2ChU+j8WTUiDq/MPdY1lSBXuVrzA78aaej7L8BU7ezjrI8BvbUFPqgPqgP6oO69gUorxX43Tn02gAAAABJRU5ErkJggg==';
/** Slash commands the agent advertises (codex-acp style: `input.hint` when the command takes text). */
const FIXTURE_COMMANDS = [
  { name: 'review', description: 'Review my current changes and find issues', input: { hint: 'optional custom review instructions' } },
  { name: 'init', description: 'Create an AGENTS.md file with instructions for Codex' },
  { name: 'compact', description: 'Summarize the conversation to free up context' },
];

/** Advertises FIXTURE_COMMANDS just after the response that opened the session (as the real agents do). */
function advertiseCommands(client, sessionId) {
  if (!SEND_COMMANDS) return;
  setTimeout(() => {
    void client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'available_commands_update', availableCommands: FIXTURE_COMMANDS },
    });
  }, 20);
}

// ---- env: codex-acp 2.x configuration (no argv) ---------------------------------------------------------------
function parseConfig(raw) {
  try {
    const v = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
const CODEX_CONFIG = parseConfig(process.env.CODEX_CONFIG);
const INITIAL_AGENT_MODE = process.env.INITIAL_AGENT_MODE ?? null;
const CODEX_PATH = process.env.CODEX_PATH ?? null;

// ---- profile data ----------------------------------------------------------------------------------------------
const CODEX_MODELS = ['gpt-6-sol', 'gpt-6.1-sol'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// codex-acp 2.x session modes (also the `mode` config option, which the app must never set: it can mean full access).
const CODEX_MODES = [
  { id: 'read-only', name: 'Read-only', description: 'Read files; ask before edits and commands' },
  { id: 'workspace-write', name: 'Workspace access', description: 'Edit in the workspace, ask for the rest' },
  { id: 'agent', name: 'Auto review', description: 'An automatic reviewer approves requests' },
  { id: 'agent-full-access', name: 'Full access', description: 'No sandbox, no approvals' },
];
const CODEX_MODE_IDS = CODEX_MODES.map((m) => m.id);
/** Turn policy per mode (what `turn/start` would send to codex app-server). */
const CODEX_MODE_POLICY = {
  'read-only': { approval_policy: 'on-request', sandbox_mode: 'read-only' },
  'workspace-write': { approval_policy: 'on-request', sandbox_mode: 'workspace-write' },
  agent: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' },
  'agent-full-access': { approval_policy: 'never', sandbox_mode: 'danger-full-access' },
};
const CODEX_COLLABORATION = ['default', 'plan'];
const CODEX_FAST = ['off', 'on'];
const CODEX_INITIAL_MODE = CODEX_MODE_IDS.includes(INITIAL_AGENT_MODE) ? INITIAL_AGENT_MODE : 'agent';
const HERMES_MODES = [
  { id: 'default', name: 'Ask before edits', description: 'Ask before every edit' },
  { id: 'accept_edits', name: 'Accept edits', description: 'Edits are applied without asking' },
  { id: 'dont_ask', name: "Don't ask", description: 'Never ask for permission' },
];
const HERMES_MODEL = 'og/deepseek-fixture';

function initialModes() {
  if (IS_HERMES) return { available: HERMES_MODES, current: 'default' };
  return { available: CODEX_MODES, current: CODEX_INITIAL_MODE };
}

const sessions = new Map();

function newState(sessionId, cwd) {
  const m = initialModes();
  return {
    sessionId,
    cwd,
    history: [], // {role:'user'|'agent', text}
    modeId: m.current,
    model: CODEX_MODELS.includes(CODEX_CONFIG.model) ? CODEX_CONFIG.model : 'gpt-6-sol',
    effort: CODEX_EFFORTS.includes(CODEX_CONFIG.model_reasoning_effort) ? CODEX_CONFIG.model_reasoning_effort : 'medium',
    collaboration: 'default',
    fast: 'off',
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
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: s.modeId,
      options: CODEX_MODES.map((m) => ({ value: m.id, name: m.name })),
    },
    {
      id: 'collaboration_mode',
      name: 'Collaboration Mode',
      category: 'collaboration_mode',
      type: 'select',
      currentValue: s.collaboration ?? 'default',
      options: CODEX_COLLABORATION.map((value) => ({ value, name: value })),
    },
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
      id: 'fast-mode',
      name: 'Fast Mode',
      category: 'model_config',
      type: 'select',
      currentValue: s.fast ?? 'off',
      options: CODEX_FAST.map((value) => ({ value, name: value })),
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

/** What this process was started with (codex: INITIAL_AGENT_MODE's turn policy, CODEX_CONFIG, CODEX_PATH). */
function spawnPolicy() {
  if (IS_HERMES) return { approval_policy: null, sandbox_mode: null, initialMode: null, codexConfig: null, codexPath: null };
  const policy = CODEX_MODE_POLICY[INITIAL_AGENT_MODE] ?? { approval_policy: null, sandbox_mode: null };
  return { ...policy, initialMode: INITIAL_AGENT_MODE, codexConfig: CODEX_CONFIG, codexPath: CODEX_PATH };
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
    ...spawnPolicy(),
    args: process.argv.slice(2),
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
    case '/slowtool': {
      // A tool call that stays in_progress for a while (the app's running tool card), then completes.
      const id = toolId();
      await update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Run sleep fixture', kind: 'execute', status: 'pending', rawInput: { command: 'sleep 3' } });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' });
      await sleep(Math.min(30_000, Number(text.trim().split(/\s+/)[1]) || 3000), signal);
      if (signal.aborted) {
        await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' });
        return finish('cancelled');
      }
      await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'slept' } }] });
      await say('slow tool done');
      return finish();
    }
    case '/warn': {
      // codex-acp streams its model-metadata warning as an agent message of its own, then the answer.
      const warnId = randomUUID();
      const warning = `Model metadata for \`${s.model}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`;
      await update({ sessionUpdate: 'agent_message_chunk', messageId: warnId, content: { type: 'text', text: warning } });
      agentText += `${warning}\n`;
      await say('warn done');
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
      // `/slow 2500`: think that long before the first tick (the app's "생각 중" row).
      const delay = Math.min(30_000, Math.max(0, Number(text.trim().split(/\s+/)[1]) || 0));
      if (delay > 0) await sleep(delay, signal);
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
      const wanted = text.trim().split(/\s+/)[1];
      const next = list.some((m) => m.id === wanted) ? wanted : list[(list.findIndex((m) => m.id === s.modeId) + 1) % list.length].id;
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
    case '/blocks': {
      // Attachments: what arrived besides the text (image mime / resource uri + kind / resource_link name).
      const kinds = (params.prompt ?? []).map((b) => {
        if (b.type === 'image') return `image:${b.mimeType}`;
        if (b.type === 'resource') return `resource:${'text' in b.resource ? 'text' : 'blob'}:${b.resource.uri.split('/').pop()}`;
        if (b.type === 'resource_link') return `resource_link:${b.name}`;
        return b.type;
      });
      await say(`BLOCKS ${kinds.join(' ')}`);
      return finish();
    }
    case '/media': {
      await say('화면을 보여 드립니다.');
      await update({ sessionUpdate: 'agent_message_chunk', messageId: randomUUID(), content: { type: 'image', data: PNG_BASE64, mimeType: 'image/png' } });
      const gen = toolId();
      await update({ sessionUpdate: 'tool_call', toolCallId: gen, title: 'Image generation', kind: 'other', status: 'in_progress', rawInput: { id: gen } });
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId: gen,
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'Revised prompt: a tiny landscape' } },
          { type: 'content', content: { type: 'image', data: PNG_BASE64, mimeType: 'image/png' } },
        ],
      });
      const shot = toolId();
      const mcpInput = { server: 'playwright', tool: 'browser_take_screenshot', arguments: { type: 'png' } };
      await update({ sessionUpdate: 'tool_call', toolCallId: shot, title: 'mcp.playwright.browser_take_screenshot', kind: 'execute', status: 'in_progress', rawInput: mcpInput });
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId: shot,
        status: 'completed',
        rawOutput: {
          result: {
            content: [
              { type: 'text', text: '### Page\n- Page URL: https://example.com/acp-capture' },
              { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
            ],
          },
          error: null,
        },
      });
      await say(' 캡처 완료.');
      return finish();
    }
    case '/spawn': {
      // codex-acp 2.x for a client without native subagent sessions: collab tool calls only.
      const spawn = toolId();
      const child = `child-${s.turn}`;
      const input = { prompt: 'README.md를 한 줄로 요약해 줘', senderThreadId: sessionId, model: s.model };
      await say('서브에이전트에게 맡깁니다.');
      await update({ sessionUpdate: 'tool_call', toolCallId: spawn, title: 'spawnAgent', kind: 'other', status: 'in_progress', rawInput: { ...input, receiverThreadIds: [], agentsStates: {}, status: 'inProgress' } });
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId: spawn,
        status: 'completed',
        rawInput: { ...input, receiverThreadIds: [child], agentsStates: { [child]: { status: 'running', message: null } }, status: 'completed' },
      });
      const wait = toolId();
      const waitInput = { prompt: null, senderThreadId: sessionId, receiverThreadIds: [child] };
      await update({ sessionUpdate: 'tool_call', toolCallId: wait, title: 'wait', kind: 'other', status: 'in_progress', rawInput: { ...waitInput, agentsStates: { [child]: { status: 'running', message: null } }, status: 'inProgress' } });
      await sleep(600, signal);
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId: wait,
        status: 'completed',
        rawInput: { ...waitInput, agentsStates: { [child]: { status: 'completed', message: 'README는 제목과 인사말 한 줄입니다.' } }, status: 'completed' },
      });
      await say(' 서브에이전트가 끝났습니다.');
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
          ...spawnPolicy(),
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
    agentInfo: { name: '@agentclientprotocol/codex-acp', title: 'Codex', version: '0.0.0-fixture' },
  };
});

app.onRequest('authenticate', () => ({}));

app.onRequest('session/new', ({ params, client }) => {
  if (AUTH_REQUIRED) throw new acp.RequestError(-32000, 'Authentication required');
  const s = newState(`fake-${randomUUID()}`, params.cwd);
  sessions.set(s.sessionId, s);
  save(s);
  advertiseCommands(client, s.sessionId);
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
    advertiseCommands(client, s.sessionId);
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
  else if (params.configId === 'mode' && CODEX_MODE_IDS.includes(params.value)) s.modeId = params.value;
  else if (params.configId === 'collaboration_mode' && CODEX_COLLABORATION.includes(params.value)) s.collaboration = params.value;
  else if (params.configId === 'fast-mode' && CODEX_FAST.includes(params.value)) s.fast = params.value;
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
