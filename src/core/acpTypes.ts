// ACP core contracts (plan 2.4 / 2.5 / 2.10 / 2.11 / 2.15, Wave 0). Type-only: no runtime code, and the SDK is
// imported for types only, so core stays pure and renderer-safe. Lane A implements these function types in
// core/acpReducer, acpPermission, acpEnv, agentDefaults, jwtClaims, redact; main (Lane B/C/E/F) depends only on
// the types here until the wave gate connects the implementations.
import type { SessionUpdate, StopReason, ToolKind } from '@agentclientprotocol/sdk';
import type {
  AcpCommandLite,
  AcpConfigOptionLite,
  AcpPermissionOptionLite,
  AgentKind,
  AppSettings,
  ChatEvent,
  CodexEffortLevel,
  EffortLevel,
  PermissionDecision,
  ToolItem,
  UiPermissionMode,
} from '../shared/types';

export type { SessionUpdate as AcpSessionUpdate, StopReason as AcpStopReason, ToolKind as AcpToolKind };

/** Agents that run over ACP. */
export type AcpAgentKind = Extract<AgentKind, 'codex' | 'hermes'>;

// ---------------------------------------------------------------------------
// Reducer (core/acpReducer.ts)
// ---------------------------------------------------------------------------

/** State carried across `session/update` notifications of one thread connection (reset per turn by the runner). */
export interface AcpReducerState {
  threadId: string;
  /** Turn counter; the plan card id is `plan-<turn>`. */
  turn: number;
  /** Assistant text item currently receiving text-deltas. */
  streamingItemId: string | null;
  /** ACP `messageId` of the streaming chunk run (a new id starts a new text item). */
  streamingMessageId: string | null;
  streamingText: string;
  /** Tool items not yet completed / failed, keyed by toolCallId. */
  pendingTools: Record<string, ToolItem>;
  /**
   * Tools that already completed / failed, keyed by toolCallId (kept across turns of one connection, capped): a late
   * `tool_call_update` merges into the settled card instead of reopening or duplicating it.
   */
  settledTools: Record<string, ToolItem>; // keyed by settledKey(toolCallId)
  /** Monotonic counter for deterministic ids. */
  seq: number;
}

/** Side information the runner applies to the thread (never rendered as chat items). */
export type AcpSignal =
  | { type: 'mode'; currentModeId: string }
  | { type: 'config'; configOptions: AcpConfigOptionLite[] }
  /** `available_commands_update`: the full list (replaces the previous one). */
  | { type: 'commands'; commands: AcpCommandLite[] }
  /** 0..100 from `usage_update` (`used / size * 100`). */
  | { type: 'context'; percent: number };

export interface AcpReduceResult {
  state: AcpReducerState;
  events: ChatEvent[];
  signals: AcpSignal[];
}

/** Synchronous: the runner applies the result before the next notification (plan 2.3 handler contract). */
export type ReduceAcpUpdateFn = (state: AcpReducerState, update: SessionUpdate, now: number) => AcpReduceResult;

/**
 * Turn end: confirms the streaming text item and settles unfinished tools (`cancelled` / `error` -> `isError`,
 * result '중단됨'). `stopReason: 'error'` = the prompt request failed.
 */
export type FinalizeAcpTurnFn = (
  state: AcpReducerState,
  stopReason: StopReason | 'error',
  now: number,
) => { state: AcpReducerState; events: ChatEvent[] };

export type InitialAcpReducerStateFn = (threadId: string, turn: number) => AcpReducerState;

/** ACP tool kind -> ToolCard name (`read` -> `Read`, ..., unknown -> first 40 chars of the title). */
export type ToolNameForFn = (kind: ToolKind | null | undefined, title: string) => string;

// ---------------------------------------------------------------------------
// Permissions (core/acpPermission.ts)
// ---------------------------------------------------------------------------

/** What to answer `session/request_permission` with; null = this decision is not offered (button disabled). */
export type AcpPermissionPick = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } | null;

/**
 * allow -> first `allow_once`; allow-session -> `allow_always` whose id / name matches /session/i, else the first
 * `allow_always`; deny -> first `reject_once`, else cancelled (never `reject_always`).
 */
export type PickOptionFn = (decision: PermissionDecision, options: readonly AcpPermissionOptionLite[]) => AcpPermissionPick;

/** The option "이 세션 동안 허용" maps to, or null (PermissionRequest.hasSessionSuggestion / sessionLabel). */
export type PickSessionOptionFn = (options: readonly AcpPermissionOptionLite[]) => AcpPermissionOptionLite | null;

// ---------------------------------------------------------------------------
// Child env (core/acpEnv.ts, plan 2.10)
// ---------------------------------------------------------------------------

export interface AcpEnvOptions {
  agent: AcpAgentKind;
  /** Scratch thread: GIT_CEILING_DIRECTORIES=<scratch root>. */
  gitCeiling?: string;
  /** Fixture agent: adds ELECTRON_RUN_AS_NODE=1 and FAKE_ACP_STATE_DIR. */
  fixture?: { stateDir: string };
}

/** Starts from the login-shell base env; never injects an API key or token. Never logged. */
export type BuildAcpEnvFn = (base: Record<string, string | undefined>, opts: AcpEnvOptions) => Record<string, string>;

// ---------------------------------------------------------------------------
// Agent defaults / Codex launch (core/agentDefaults.ts, plan 2.11 / 2.15)
// ---------------------------------------------------------------------------

/** Model / effort a new draft gets when this agent is selected (Hermes: `''` / null = system default). */
export type DraftAgentDefaultsFn = (
  agent: AgentKind,
  settings: Pick<AppSettings, 'defaultModel' | 'defaultEffort' | 'codexDefaultModel' | 'codexDefaultEffort'>,
) => { model: string; effort: EffortLevel | CodexEffortLevel | null };

export interface CodexLaunchInput {
  model: string | null;
  effort: EffortLevel | CodexEffortLevel | null;
  permissionMode: UiPermissionMode;
}

/**
 * codex-acp 2.x launch env: `CODEX_CONFIG` (JSON thread config: model / model_reasoning_effort) and
 * `INITIAL_AGENT_MODE` (session mode id). Process-only; `~/.codex/config.toml` is never written. Values come from the
 * fixed permission table and validated model / effort only.
 */
export type CodexLaunchEnvResult =
  | { ok: true; env: { CODEX_CONFIG: string; INITIAL_AGENT_MODE: string } }
  | { ok: false; error: 'invalid-model' | 'invalid-effort' };

export type CodexLaunchEnvFn = (input: CodexLaunchInput) => CodexLaunchEnvResult;

/** One `session/set_config_option` the runner should send after a session opened. */
export interface AcpConfigSet {
  configId: string;
  value: string;
}

/** A wanted value the agent does not offer: warn and adopt the agent's current value. */
export interface AcpConfigMissing {
  category: 'model' | 'thought_level';
  wanted: string;
  current: string | null;
}

export interface AcpConfigReconcile {
  set: AcpConfigSet[];
  missing: AcpConfigMissing[];
}

/** Compares the opened session's config options (by category) with the thread's model / effort. */
export type ReconcileConfigFn = (
  configOptions: readonly AcpConfigOptionLite[],
  wanted: { model: string | null; effort: EffortLevel | CodexEffortLevel | null },
) => AcpConfigReconcile;

// ---------------------------------------------------------------------------
// Redaction / JWT (core/redact.ts, core/jwtClaims.ts)
// ---------------------------------------------------------------------------

/** Masks `sk-...`, JWTs, `Bearer ...` and long hex / base64 runs. */
export type RedactFn = (text: string) => string;

/** Display claims of a Codex `id_token` payload (signature not verified). No token material. */
export interface JwtClaimsLite {
  email: string | null;
  /** `["https://api.openai.com/auth"].chatgpt_plan_type` */
  plan: string | null;
  /** epoch seconds */
  exp: number | null;
}

/** Decodes the payload only; malformed input -> null (never throws). */
export type DecodeJwtClaimsFn = (jwt: string) => JwtClaimsLite | null;
