// Shared domain types. Every type that crosses a lane / process boundary lives here.
// Pure type module: no runtime imports, safe for main, preload, renderer and core.

// ---------------------------------------------------------------------------
// Permissions / limits
// ---------------------------------------------------------------------------

/** Permission modes exposed in the UI (subset of SDK PermissionMode). */
export type UiPermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

export type LimitKind = 'fiveHour' | 'sevenDay' | 'fable';

/** Reasoning effort (SDK `EffortLevel`, Options.effort / applyFlagSettings({effortLevel})). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Model-scoped weekly limit buckets (SDK `seven_day_<model>` rate limit types). */
export type ModelLimitKind = 'fable' | 'opus' | 'sonnet';

export interface LimitReading {
  /** 0..100 */
  percent: number;
  /** epoch ms, null when unknown */
  resetsAt: number | null;
}

export type UsageError = 'rate_limited' | 'auth' | 'network' | 'no_credentials' | 'token_expired';

export interface AccountUsage {
  fiveHour?: LimitReading;
  sevenDay?: LimitReading;
  fable?: LimitReading;
  /** epoch ms of last successful fetch (or last event applied) */
  fetchedAt: number;
  /** true when data is older than STALE_AFTER_MS or could not be refreshed */
  stale: boolean;
  error?: UsageError;
  /**
   * Per-kind block release time (epoch ms) derived from SDK rate_limit_event / overage detection.
   * `fable` / `opus` / `sonnet` are model-scoped weekly buckets: they only block a thread whose resolvedModel matches.
   */
  rejectedUntil?: Partial<Record<LimitKind | ModelLimitKind | 'overage', number>>;
  /** `extra_usage` enabled on the account (billing risk badge). */
  extraUsageEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Accounts / projects / threads
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  alias: string;
  /** hex color from ACCOUNT_COLORS */
  color: string;
  email: string | null;
  /** subscriptionType from `claude auth status --json` (e.g. "max", "pro") */
  plan: string | null;
  /** Absolute CLAUDE_CONFIG_DIR string, no trailing slash. Hashed verbatim for Keychain name. */
  configDir: string;
  /** Lower = preferred. */
  priority: number;
  enabled: boolean;
  createdAt: number;
}

export type AccountPatch = Partial<Pick<Account, 'alias' | 'color' | 'enabled'>>;

export interface Project {
  id: string;
  name: string;
  /** Absolute folder path chosen by the user. */
  path: string;
  /**
   * User confirmed the folder is trusted: the repo's `.claude` settings (hooks, permissions) are loaded
   * (settingSources user+project+local). Untrusted projects run with `settingSources: ['user']`.
   */
  trusted: boolean;
  createdAt: number;
}

export interface PendingPrompt {
  text: string;
  kind: 'original' | 'continue';
}

export type ThreadStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  /** Session cwd: worktree path, or project folder when not a git repo. */
  cwd: string;
  worktree?: WorktreeInfo;
  /** Model selected by the user (alias or id). */
  model: string;
  /** Actual model reported by SDK init message. */
  resolvedModel: string | null;
  permissionMode: UiPermissionMode;
  /** Reasoning effort for this thread's Queries; null = the model's default. */
  effort: EffortLevel | null;
  pinnedAccountId: string | null;
  /** Shown in the sidebar's "pinned threads" section. */
  pinned: boolean;
  /** Hidden from the project thread lists (not deleted). */
  archived: boolean;
  /** Account holding the freshest transcript copy (received >= 1 output). */
  lastAccountId: string | null;
  /** Account of the currently open / last used Query. */
  activeAccountId: string | null;
  sdkSessionId: string | null;
  status: ThreadStatus;
  /** epoch ms, set while status === 'waiting' */
  waitingUntil: number | null;
  pendingPrompt: PendingPrompt | null;
  sessionStartedAt: number | null;
  /** 0..100 from Query.getContextUsage().percentage */
  ctxPercent: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  /** Close idle Query after N minutes (resume on next send). */
  idleCloseMinutes: number;
  defaultModel: string;
  defaultPermissionMode: UiPermissionMode;
  /** Multi-account ToS notice shown once on first account add. */
  tosNoticeAcknowledged: boolean;
}

export interface PersistedState {
  version: 1;
  projects: Project[];
  threads: Thread[];
  accounts: Account[];
  settings: AppSettings;
}

// ---------------------------------------------------------------------------
// Chat items / events
// ---------------------------------------------------------------------------

export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface ChatItemBase {
  /** Stable id; re-sent item-upsert with same id replaces the previous one. */
  id: string;
  createdAt: number;
}

export interface UserItem extends ChatItemBase {
  type: 'user';
  text: string;
}

export interface AssistantTextItem extends ChatItemBase {
  type: 'assistant-text';
  text: string;
}

export interface ToolItem extends ChatItemBase {
  type: 'tool';
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  /** Tool result rendered as text (undefined while pending). */
  result?: string;
  isError?: boolean;
  /** From Edit/Write tool_use_result.structuredPatch */
  patch?: StructuredPatchHunk[];
}

export interface SystemNoticeItem extends ChatItemBase {
  type: 'notice';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export type ChatItem = UserItem | AssistantTextItem | ToolItem | SystemNoticeItem;

export type TurnEndReason = 'rate_limited' | 'interrupted' | 'error' | 'auth';

export type ChatEvent =
  | { type: 'text-delta'; itemId: string; text: string }
  | { type: 'item-upsert'; item: ChatItem }
  | { type: 'turn-start'; accountId: string }
  | { type: 'turn-end'; ok: boolean; reason?: TurnEndReason }
  | { type: 'error'; message: string };

/** Subset of SDKRateLimitInfo so renderer/core never import the SDK at runtime. */
export interface RateLimitInfoLite {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** epoch seconds or ms (normalize with normalizeEpoch) */
  resetsAt?: number;
  rateLimitType?:
    | 'five_hour'
    | 'seven_day'
    | 'seven_day_opus'
    | 'seven_day_sonnet'
    | 'seven_day_fable'
    | 'seven_day_overage_included'
    | 'overage';
  /** Fraction of the window used (0..1, may exceed 1), per the CLI's anthropic-ratelimit-unified-* headers. */
  utilization?: number;
  isUsingOverage?: boolean;
  overageInUse?: boolean;
  overageResetsAt?: number;
}

export type RunnerSignal =
  | { type: 'session-init'; sessionId: string; cliVersion: string | null; model: string | null }
  | { type: 'rate-limit'; info: RateLimitInfoLite }
  | { type: 'rate-limit-hit' }
  | { type: 'overage'; info: RateLimitInfoLite }
  | { type: 'auth-failed' }
  | { type: 'output' };

/** State carried by core/chatReducer across SDK messages of one Query. */
export interface ChatReducerState {
  threadId: string;
  /** Assistant text item currently receiving text-deltas. */
  streamingItemId: string | null;
  streamingText: string;
  /** Tool items awaiting result, keyed by toolUseId. */
  pendingTools: Record<string, ToolItem>;
  /** `output` signal already emitted for this Query. */
  outputEmitted: boolean;
  /** Monotonic counter for deterministic ids. */
  seq: number;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  /** SDK canUseTool options.requestId */
  requestId: string;
  threadId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  displayName?: string;
  hasSessionSuggestion: boolean;
  defaultToNo?: boolean;
}

export type PermissionDecision = 'allow' | 'allow-session' | 'deny';

// ---------------------------------------------------------------------------
// Pool / usage
// ---------------------------------------------------------------------------

export interface PoolSummary {
  avg: Record<LimitKind, number | null>;
  earliestReset: Record<LimitKind, number | null>;
  available: number;
  total: number;
}

export interface PoolSnapshot {
  summary: PoolSummary;
  usageById: Record<string, AccountUsage>;
  at: number;
}

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
  /**
   * Effort levels the model accepts (SDK ModelInfo.supportedEffortLevels). `[]` = no effort support;
   * undefined = unknown (the fallback list before a live Query reported its models).
   */
  effortLevels?: EffortLevel[];
}

export interface UsageSample {
  at: number;
  fiveHour: number | null;
  sevenDay: number | null;
  fable: number | null;
}

// ---------------------------------------------------------------------------
// Rotation / env (core function I/O)
// ---------------------------------------------------------------------------

export type PickDecision =
  | { type: 'account'; accountId: string }
  | { type: 'waiting'; until: number }
  /** `reason: 'auth'`: every enabled account failed authentication (re-login needed; waiting would never end). */
  | { type: 'none'; reason?: 'auth' };

export interface PickAccountInput {
  accounts: Account[];
  usageById: Record<string, AccountUsage>;
  pinnedAccountId: string | null;
  resolvedModel: string | null;
  /** Thread.model; an explicit model scopes the model limits while `resolvedModel` is still unknown. */
  model?: string | null;
  exclude?: Set<string>;
  now: number;
}

export interface ChildEnvInject {
  configDir?: string;
  term?: string;
  clientApp?: string;
}

// ---------------------------------------------------------------------------
// Chat send
// ---------------------------------------------------------------------------

export interface ChatSendResult {
  accepted: boolean;
  /** `auth`: every enabled account needs to log in again. */
  reason?: 'waiting' | 'no-accounts' | 'busy' | 'auth';
}

export interface BootstrapPayload {
  projects: Project[];
  threads: Thread[];
  accounts: Account[];
  pool: PoolSnapshot;
  settings: AppSettings;
  appVersion: string;
  /** User home directory (paths are shown with `~`). */
  homeDir: string;
  /** Permission requests still awaiting an answer (renderer reload re-shows the cards). */
  pendingPermissions: PermissionRequest[];
}

// ---------------------------------------------------------------------------
// Thread start (draft -> first send)
// ---------------------------------------------------------------------------

export interface ThreadStartRequest {
  projectId: string;
  text: string;
  model?: string;
  permissionMode?: UiPermissionMode;
  effort?: EffortLevel | null;
  pinnedAccountId?: string | null;
}

/**
 * `ok: false` means nothing was created (no thread, no worktree): the first message could not be sent, and the
 * renderer keeps the draft text.
 */
export type ThreadStartResult =
  | { ok: true; thread: Thread; send: ChatSendResult }
  | { ok: false; reason: NonNullable<ChatSendResult['reason']> };
