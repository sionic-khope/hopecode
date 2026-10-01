// Lightweight runners for 노트 모드 requests: one prompt in, streamed text out, no tools.
// Claude: the Agent SDK on an account from the pool (same rotation policy as threads), `tools: []`, a single turn, no
// session persistence, every tool request denied. Codex: the ACP adapter in its read-only mode, every permission
// request cancelled. Neither engine writes the note: the renderer applies the text to the editor.
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
  // `plan` maps to codex-acp's read-only mode: the agent may not write files or run commands.
  const launch = await deps.codexLauncher.resolve(deps.runDir, { model, effort, permissionMode: 'plan' });
  if (!launch.ok) return { ok: false, stopped: false, error: 'Codex를 시작할 수 없습니다' };
  let sessionId: string | null = null;
  const conn = new AcpConnection({
    spec: launch.spec,
    cwd: deps.runDir,
    appVersion: deps.appVersion,
    log: deps.log,
    handlers: {
      onUpdate(params: SessionNotification) {
        if (params.sessionId !== sessionId) return;
        const u = params.update;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') onDelta(u.content.text);
      },
      // No tool may run for a note request.
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    },
  });
  let stopped = false;
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
    await conn.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: `${run.system}\n\n---\n\n${run.prompt}` }] },
      null,
    );
    return { ok: true, stopped };
  } catch (err) {
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
