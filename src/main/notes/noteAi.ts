// Lightweight runners for 노트 모드 requests: one prompt in, streamed text out.
// Claude: the Agent SDK on an account from the pool (same rotation policy as threads), `tools: []`, no MCP server
// (strict MCP config), a single turn, no session persistence, every tool request denied.
// Codex: the ACP adapter in its read-only sandbox with the tool families Codex can switch off by config turned off
// (agentDefaults NOTE_CODEX_FEATURES_OFF). Read-only still lets a shell command read any file the user can, and not
// every tool has a config key, so the runner fails closed: the first tool call cancels the turn and the request ends
// in an error (the renderer then puts the note back as it was). Neither engine writes the note: the renderer applies
// the text to the editor.
import { mkdirSync } from 'node:fs';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { pickAccount } from '../../core/rotationPolicy';
import { CLIENT_APP_NAME, CODEX_EFFORT_LEVELS, CODEX_MODEL_PATTERN, EFFORT_LEVELS } from '../../shared/constants';
import type { Account } from '../../shared/types';
import type { NoteAgent } from '../../shared/notes';
import type { AcpLauncher, ClaudeBinary, QueryFn, ShellEnv, UsagePoller } from '../contracts';
import { claudeConfigDirFor } from '../accounts/localDefault';
import { AcpConnection } from '../acp/acpConnection';
import { ACP_SESSION_OPEN_TIMEOUT_MS } from '../../shared/constants';

export interface NoteAiDeps {
  query: QueryFn;
  listAccounts: () => Account[];
  usage: Pick<UsagePoller, 'getSnapshot'>;
  shellEnv: Pick<ShellEnv, 'childEnv'>;
  claudeBinary: Pick<ClaudeBinary, 'resolvePath'>;
  appVersion: string;
  codexLauncher: AcpLauncher;
  /** Codex installed and logged in (local auth detection). */
  codexUsable: () => boolean;
  /** Names of the user's Codex MCP servers (`config.toml`), disabled for the note session. */
  codexMcpServers: () => string[];
  /** Private working folder for the engines (never the vault). */
  runDir: string;
  now: () => number;
  log: (message: string, err?: unknown) => void;
}

export interface NoteAiRun {
  agent: NoteAgent;
  model: string | null;
  effort: string | null;
  system: string;
  prompt: string;
}

export type NoteAiResult = { ok: true; stopped: boolean } | { ok: false; error: string; stopped: boolean };

/** Error of a Codex note request that tried to use a tool (the streamed text is discarded). */
export const TOOL_BLOCKED_ERROR = 'Codex가 도구를 쓰려고 해서 요청을 중단했습니다. 받은 내용은 버리고 노트를 그대로 두었습니다.';

const MODEL_VALUE = /^[A-Za-z0-9._\-[\]]{1,200}$/;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Text deltas of one SDK message (partial stream events), or the full text of an assistant message. */
function sdkText(m: SDKMessage): { delta: string } | { full: string } | null {
  if (m.type === 'stream_event') {
    const ev = m.event as { type?: string; delta?: { type?: string; text?: string } };
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') return { delta: ev.delta.text };
    return null;
  }
  if (m.type === 'assistant' && m.parent_tool_use_id === null) {
    const content = (m.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    const text = content
      .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('');
    return { full: text };
  }
  return null;
}

async function runClaude(deps: NoteAiDeps, run: NoteAiRun, onDelta: (text: string) => void, signal: AbortSignal): Promise<NoteAiResult> {
  const accounts = deps.listAccounts();
  const model = run.model && run.model !== 'default' && MODEL_VALUE.test(run.model) ? run.model : null;
  const decision = pickAccount({
    accounts,
    usageById: deps.usage.getSnapshot().usageById,
    pinnedAccountId: null,
    resolvedModel: null,
    model,
    exclude: new Set(),
    now: deps.now(),
  });
  const account = decision.type === 'account' ? accounts.find((a) => a.id === decision.accountId) : undefined;
  if (!account) return { ok: false, stopped: false, error: '지금 쓸 수 있는 Claude 계정이 없습니다' };

  const abort = new AbortController();
  const effort = run.effort && (EFFORT_LEVELS as readonly string[]).includes(run.effort) ? run.effort : null;
  const options: Options = {
    cwd: deps.runDir,
    systemPrompt: run.system,
    tools: [],
    maxTurns: 1,
    includePartialMessages: true,
    persistSession: false,
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    permissionMode: 'default',
    canUseTool: async () => ({ behavior: 'deny', message: '노트 요청에서는 도구를 쓸 수 없습니다' }),
    ...(model ? { model } : {}),
    ...(effort ? { effort: effort as Options['effort'] } : {}),
    pathToClaudeCodeExecutable: deps.claudeBinary.resolvePath(),
    env: deps.shellEnv.childEnv({ configDir: claudeConfigDirFor(account), clientApp: `${CLIENT_APP_NAME}/${deps.appVersion}` }),
    stderr: (data: string) => deps.log(`[notes:claude] ${data.trimEnd()}`),
    abortController: abort,
  };
  const q = deps.query({ prompt: run.prompt, options });
  let stopped = false;
  const onAbort = () => {
    stopped = true;
    q.close();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  let streamed = false;
  let error: string | null = null;
  try {
    for await (const m of q) {
      const text = sdkText(m);
      if (text && 'delta' in text) {
        streamed = true;
        onDelta(text.delta);
      } else if (text && 'full' in text && !streamed && text.full) {
        streamed = true;
        onDelta(text.full);
      } else if (m.type === 'result' && m.is_error && !stopped) {
        const errors = (m as { errors?: unknown }).errors;
        error = Array.isArray(errors) && errors.length > 0 ? String(errors[0]) : '응답을 받지 못했습니다';
      }
    }
  } catch (err) {
    if (!stopped) error = errText(err);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return error ? { ok: false, stopped, error } : { ok: true, stopped };
}

async function runCodex(deps: NoteAiDeps, run: NoteAiRun, onDelta: (text: string) => void, signal: AbortSignal): Promise<NoteAiResult> {
  if (!deps.codexUsable()) return { ok: false, stopped: false, error: 'Codex가 설치되어 있지 않거나 로그인되어 있지 않습니다' };
  const model = run.model && CODEX_MODEL_PATTERN.test(run.model) ? run.model : null;
  const effort = run.effort && (CODEX_EFFORT_LEVELS as readonly string[]).includes(run.effort) ? run.effort : null;
  // `plan` maps to codex-acp's read-only sandbox; `noTools` switches off the tools Codex has config keys for.
  const launch = await deps.codexLauncher.resolve(deps.runDir, { model, effort, permissionMode: 'plan', noTools: { mcpServers: deps.codexMcpServers() } });
  if (!launch.ok) return { ok: false, stopped: false, error: 'Codex를 시작할 수 없습니다' };
  let sessionId: string | null = null;
  let stopped = false;
  /** A tool call was seen: the turn is cancelled and nothing more reaches the editor. */
  let toolBlocked = false;
  let onBlocked: () => void = () => {};
  const blockedSeen = new Promise<void>((resolve) => {
    onBlocked = resolve;
  });
  const block = (what: string) => {
    if (toolBlocked) return;
    toolBlocked = true;
    deps.log(`[notes:codex] ${what} in a note request; turn cancelled`);
    if (sessionId) conn.notify('session/cancel', { sessionId });
    onBlocked();
  };
  const conn = new AcpConnection({
    spec: launch.spec,
    cwd: deps.runDir,
    appVersion: deps.appVersion,
    log: deps.log,
    handlers: {
      onUpdate(params: SessionNotification) {
        if (params.sessionId !== sessionId || toolBlocked) return;
        const u = params.update;
        if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
          block(u.sessionUpdate);
          return;
        }
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') onDelta(u.content.text);
      },
      // No tool may run for a note request: a permission request is a tool call as well.
      onPermission: async () => {
        block('permission request');
        return { outcome: { outcome: 'cancelled' } };
      },
    },
  });
  const blocked = (): NoteAiResult => ({ ok: false, stopped: false, error: TOOL_BLOCKED_ERROR });
  const onAbort = () => {
    stopped = true;
    if (sessionId) conn.notify('session/cancel', { sessionId });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await conn.initialize(signal);
    const opened = await conn.request('session/new', { cwd: deps.runDir, mcpServers: [] }, ACP_SESSION_OPEN_TIMEOUT_MS, signal);
    sessionId = opened.sessionId;
    if (signal.aborted) return { ok: true, stopped: true };
    // The turn ends on its own or at the first tool call (the connection is closed below either way).
    await Promise.race([
      conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${run.system}\n\n---\n\n${run.prompt}` }] }, null),
      blockedSeen,
    ]);
    return toolBlocked ? blocked() : { ok: true, stopped };
  } catch (err) {
    if (toolBlocked) return blocked();
    if (stopped || signal.aborted) return { ok: true, stopped: true };
    return { ok: false, stopped: false, error: errText(err) };
  } finally {
    signal.removeEventListener('abort', onAbort);
    await conn.close({ sessionId }).catch((err: unknown) => deps.log('[notes:codex] close failed', err));
  }
}

/** Runs one note request; `onDelta` receives the answer as it streams. Never throws. */
export async function runNoteAi(deps: NoteAiDeps, run: NoteAiRun, onDelta: (text: string) => void, signal: AbortSignal): Promise<NoteAiResult> {
  try {
    mkdirSync(deps.runDir, { recursive: true, mode: 0o700 });
    return run.agent === 'codex' ? await runCodex(deps, run, onDelta, signal) : await runClaude(deps, run, onDelta, signal);
  } catch (err) {
    deps.log('[notes] ai request failed', err);
    return { ok: false, stopped: false, error: errText(err) };
  }
}
