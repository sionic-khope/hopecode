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

/** Codex reasoning effort (`model_reasoning_effort`; codex models_cache supported_reasoning_levels). Not Claude's set. */
export type CodexEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

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
  /**
   * `local-default`: the Mac's own Claude Code login (`paths.localClaudeDir()`, base Keychain service). Never
   * deleted (no config dir / Keychain removal) and never given CLAUDE_CONFIG_DIR. Absent = `managed`.
   */
  source?: 'managed' | 'local-default';
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
  /** Composer image attachments sent with `text` (image content blocks). */
  images?: ChatImage[];
  /** Composer PDF / text attachments sent with `text` (document blocks; ACP resource blocks). */
  files?: PromptFile[];
}

export type ThreadStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/**
 * Coding agent that runs a thread's sessions. Each kind has an entry in shared/agents.ts (AGENTS) and a runner
 * branch in main's SessionManager: Claude Code runs on the Agent SDK, Codex / Hermes over ACP (stdio).
 */
export type AgentKind = 'claude-code' | 'codex' | 'hermes';

/** One ACP session mode (`SessionModeState.availableModes[]`). */
export interface AcpModeLite {
  id: string;
  name: string;
  description?: string;
}

/** One value of a select config option (groups are flattened). */
export interface AcpConfigValueLite {
  value: string;
  name: string;
  description?: string;
}

/** ACP `SessionConfigOption` reduced to what the composer renders (no `_meta`). */
export type AcpConfigOptionLite = {
  id: string;
  name: string;
  description?: string;
  /** `mode` | `model` | `model_config` | `thought_level` | agent-specific; null when the agent sent none. */
  category: string | null;
} & ({ type: 'select'; currentValue: string; options: AcpConfigValueLite[] } | { type: 'boolean'; currentValue: boolean });

/** Controls an ACP agent reported for a session (modes, config options). Persisted on the thread; no secrets. */
export interface AcpControls {
  modes: AcpModeLite[];
  currentModeId: string | null;
  configOptions: AcpConfigOptionLite[];
  /** Hermes' non-standard `models.currentModelId` (read-only label, 120 chars max); null when not reported. */
  reportedModel: string | null;
  /** Slash commands from the latest `available_commands_update` (absent until the agent sent one). */
  commands?: AcpCommandLite[];
}

/** ACP `AvailableCommand` reduced to what the composer's slash picker renders. */
export interface AcpCommandLite {
  name: string;
  description: string;
  /** `input.hint` of an unstructured input; null = the command takes no input. */
  hint: string | null;
}

/** ACP session state of a Codex / Hermes thread (absent on Claude threads). */
export interface ThreadAcpState {
  /** ACP session id to `session/load` on the next connection; null before the first `session/new`. */
  sessionId: string | null;
  controls: AcpControls | null;
  /** Mode chosen while no connection was open; applied right after the next session opens. */
  pendingModeId?: string | null;
  /** `promptCapabilities` of the last initialize (absent until a session opened: composer uses the agent defaults). */
  promptCapabilities?: AcpPromptCaps;
}

/** ACP `PromptCapabilities` (absent fields = false). Decides which composer attachments an ACP agent takes. */
export interface AcpPromptCaps {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export interface Thread {
  id: string;
  /** null = a chat without a project (runs in an app-managed scratch folder, no git). */
  projectId: string | null;
  /** Agent that runs this thread (persisted; threads saved before agents existed migrate to 'claude-code'). */
  agent: AgentKind;
  title: string;
  /** Session cwd: worktree path, or project folder when not a git repo. */
  cwd: string;
  worktree?: WorktreeInfo;
  /** Model selected by the user (alias or id). */
  model: string;
  /** Actual model reported by SDK init message. */
  resolvedModel: string | null;
  permissionMode: UiPermissionMode;
  /** Reasoning effort for this thread's Queries (Codex threads: CodexEffortLevel); null = the model's default. */
  effort: EffortLevel | CodexEffortLevel | null;
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
  /** ACP session state (Codex / Hermes threads only). */
  acp?: ThreadAcpState;
}

/** External apps the "에디터에서 열기" menu can hand a thread folder to (detected in /Applications). */
export type EditorId = 'vscode' | 'cursor' | 'zed' | 'xcode' | 'finder' | 'terminal' | 'iterm' | 'ghostty';

export interface EditorInfo {
  id: EditorId;
  /** Display name ("Visual Studio Code"). */
  name: string;
}

export interface AppSettings {
  /** Name shown in the sidebar profile row; '' = the active account's alias / email. Trimmed, at most 40 chars. */
  profileName: string;
  /** Close idle Query after N minutes (resume on next send); 0 = never. */
  idleCloseMinutes: number;
  /** Model of a new chat (draft). */
  defaultModel: string;
  /** Permission mode of a new chat; never `bypassPermissions` (that needs the per-thread confirm). */
  defaultPermissionMode: UiPermissionMode;
  /** Effort of a new chat; null = the model's default. */
  defaultEffort: EffortLevel | null;
  /** New threads get their own git worktree; off = sessions work directly in the project folder. */
  useWorktree: boolean;
  /** Rate-limited turns move to the next account; off = the thread waits for its own account to reset. */
  autoSwitchAccounts: boolean;
  /** Usage poll interval per account, seconds (USAGE_POLL_MIN_SEC..USAGE_POLL_MAX_SEC). */
  usagePollIntervalSec: number;
  /** macOS notifications while the window is in the background (turn done, permission request, account switch). */
  notifications: boolean;
  /** UI sounds (voice blips while a reply streams, clicks, send / done / error). Off = silent at once. */
  soundEnabled: boolean;
  /** Default target of "에디터에서 열기"; null = the first detected editor. */
  defaultEditor: EditorId | null;
  /** Multi-account ToS notice shown once on first account add. */
  tosNoticeAcknowledged: boolean;
  /**
   * "New Task Start" composer template (draft screen button / ⌘⇧N / command palette). `{project}` / `{date}` are
   * substituted before it lands in the composer. Never empty (falls back to the default); at most 4000 chars.
   */
  newTaskTemplate: string;
  /**
   * The Mac's own Claude Code login joins the account pool (`Account.source === 'local-default'`). Changed only
   * through `account:setLocalDefault`.
   */
  localClaudeInPool: boolean;
  /** Codex model of a new chat (ACP config option value, e.g. `gpt-6.1-sol`). */
  codexDefaultModel: string;
  /** Codex reasoning effort of a new chat. */
  codexDefaultEffort: CodexEffortLevel;
  /**
   * Codex executable override (absolute path; '' = auto-detect: ChatGPT.app, login-shell PATH, common dirs). Stored
   * only after `--version` reported a supported `codex-cli`.
   */
  codexPath: string;
  /** Settings schema revision (SETTINGS_REV); drives one-time default migrations. Not user-editable. */
  settingsRev: number;
}

/** Fields `settings:update` may change (ToS acknowledgement, pool membership and the revision have their own flows). */
export type SettingsPatch = Partial<Omit<AppSettings, 'tosNoticeAcknowledged' | 'localClaudeInPool' | 'settingsRev'>>;

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

/** Base64 image carried by a chat item (tool_result image block, composer attachment). */
export interface ChatImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64 payload without the `data:` prefix ('' once main moved it to the media store: see `ref`). */
  data: string;
  /**
   * Media store file (`<sha256>.<ext>` under the app data folder) holding the image when the thread log keeps only a
   * reference (agent images are never written into the log as base64). The renderer reads it with `image:read`.
   */
  ref?: string;
}

/** Kind of a composer attachment: image block, PDF document, or a UTF-8 text / code file. */
export type AttachmentKind = 'image' | 'pdf' | 'text';

/** A PDF / text attachment as the user bubble shows it. The thread log keeps only this (never the content). */
export interface ChatFileMeta {
  kind: 'pdf' | 'text';
  name: string;
  mediaType: string;
  /** Bytes. */
  size: number;
}

/** PDF / text content main sends with a prompt. Built in main from validated files; never comes from the renderer. */
export interface PromptFile extends ChatFileMeta {
  /** `pdf`: base64 payload; `text`: the UTF-8 text. */
  data: string;
  /** Real path of a picked / dropped file (ACP resource uri / resource_link); absent for pasted bytes. */
  path?: string;
}

/** A validated attachment main holds for the composer (`attach:*`); `chat:send` / `thread:start` refer to it by id. */
export interface AttachmentInfo {
  id: string;
  kind: AttachmentKind;
  name: string;
  mediaType: string;
  /** Bytes (after scaling an image down). */
  size: number;
  /** Came from a file on disk (picker / drop): an ACP agent without embeddedContext still gets a resource_link. */
  linkable: boolean;
  /** Image attachments: the image itself (thumbnail). */
  image?: ChatImage;
  /** The image was scaled down to fit the size limit. */
  resized?: boolean;
}

export interface AttachRejection {
  name: string;
  reason: string;
}

export interface AttachResult {
  attachments: AttachmentInfo[];
  rejected: AttachRejection[];
}

export interface UserItem extends ChatItemBase {
  type: 'user';
  text: string;
  /** Images pasted / dropped into the composer and sent as image content blocks. */
  images?: ChatImage[];
  /** PDF / text attachments sent with the message (names only). */
  files?: ChatFileMeta[];
}

export interface AssistantTextItem extends ChatItemBase {
  type: 'assistant-text';
  text: string;
  /** SDK `parent_tool_use_id`: text written inside the subagent started by that Task/Agent tool_use. */
  parentToolUseId?: string;
  /** Images the agent sent as message content (ACP `agent_message_chunk` image blocks). */
  images?: ChatImage[];
}

/** Whole-file diff reported by an ACP agent (`ToolCallContent` `diff`). */
export interface ToolFileDiff {
  path: string;
  /** '' for a new file. */
  oldText: string;
  newText: string;
  /** Text was cut to the size cap. */
  truncated?: boolean;
}

export interface ToolItem extends ChatItemBase {
  type: 'tool';
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  /** ACP `diff` content of the tool call (rendered with DiffView oldText/newText). */
  diffs?: ToolFileDiff[];
  /** Tool result rendered as text (undefined while pending). */
  result?: string;
  isError?: boolean;
  /** From Edit/Write tool_use_result.structuredPatch */
  patch?: StructuredPatchHunk[];
  /** SDK `parent_tool_use_id`: the call ran inside the subagent started by that Task/Agent tool_use. */
  parentToolUseId?: string;
  /** Image blocks of the tool_result (Read of an image file, screenshots). */
  images?: ChatImage[];
  /** epoch ms the result arrived (or a background subagent's task_notification). */
  completedAt?: number;
  /**
   * Background subagent (Task/Agent result `async_launched`): the tool_result arrives at launch, the run settles
   * later with a task_notification. Absent for foreground calls (their result is the end of the run).
   */
  taskStatus?: 'running' | 'completed' | 'failed' | 'stopped';
}

/** Image files created or changed in the thread folder during one turn (paths relative to the thread cwd). */
export interface ImageGalleryItem extends ChatItemBase {
  type: 'image-gallery';
  paths: string[];
}

export interface SystemNoticeItem extends ChatItemBase {
  type: 'notice';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export type ChatItem = UserItem | AssistantTextItem | ToolItem | SystemNoticeItem | ImageGalleryItem;

export type TurnEndReason = 'rate_limited' | 'interrupted' | 'error' | 'auth';

export type ChatEvent =
  | { type: 'text-delta'; itemId: string; text: string }
  | { type: 'item-upsert'; item: ChatItem }
  /** `accountId` is absent for agents without account rotation (Codex / Hermes). */
  | { type: 'turn-start'; accountId?: string }
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
  /** Background subagent tool items (result `async_launched`) awaiting their task_notification, by toolUseId. */
  backgroundTools?: Record<string, ToolItem>;
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
  /** Agent that asked (absent = claude-code). */
  agent?: AgentKind;
  /** ACP permission options as the agent sent them; the card enables / annotates its buttons from these. */
  agentOptions?: AcpPermissionOptionLite[];
  /** The agent's own name for the option behind "이 세션 동안 허용" (shown as the button's caption). */
  sessionLabel?: string;
}

/** ACP `PermissionOption` without `_meta`. */
export interface AcpPermissionOptionLite {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
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
  /** Concrete model id this row runs as (SDK ModelInfo.resolvedModel: `default` -> `claude-fable-5-1`). */
  resolvedModel?: string;
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
  /** GIT_CEILING_DIRECTORIES (scratch threads: stop git from finding a repository above the scratch root). */
  gitCeiling?: string;
}

// ---------------------------------------------------------------------------
// Chat send
// ---------------------------------------------------------------------------

export interface ChatSendResult {
  accepted: boolean;
  /**
   * `auth`: every enabled account needs to log in again. `agent-unavailable`: the thread's agent is not installed
   * or not logged in on this Mac. `attachment`: an attachment id is unknown (expired) or the agent cannot take it.
   */
  reason?: 'waiting' | 'no-accounts' | 'busy' | 'auth' | 'agent-unavailable' | 'attachment';
}

// ---------------------------------------------------------------------------
// Local agent auth / agent usage
// ---------------------------------------------------------------------------

export type LocalAuthState = 'logged-in' | 'logged-out' | 'not-installed' | 'error';

/**
 * What the app detected about an agent's own login on this Mac (read-only). Carries no credential material by
 * construction: there is no field a token or key could go into.
 */
export interface LocalAuthInfo {
  agent: AgentKind;
  state: LocalAuthState;
  /** 'claude.ai' | 'chatgpt' | 'api-key' | 'provider' (Hermes) */
  method: 'claude.ai' | 'chatgpt' | 'api-key' | 'provider' | null;
  email: string | null;
  plan: string | null;
  /** Hermes: active provider id (the agent-type auth method id of ACP initialize). */
  provider: string | null;
  /** Hermes: credential count per provider from `hermes auth list` (no labels, no values). */
  providers?: { id: string; count: number }[];
  /** Hermes: system default model id (`model.default` of config.yaml), e.g. `deepseek/deepseek-v4.1-flash-ultrafast`. */
  defaultModel?: string | null;
  /** Hermes: provider of the default model (`model.provider`). */
  defaultProvider?: string | null;
  /** Display-only origin ('~/.codex/auth.json', 'Keychain: Claude Code-credentials', '~/.local/bin/hermes'). */
  source: string;
  version: string | null;
  /** Codex: the detected engine executable (`codex app-server`), shown on the Accounts card. */
  enginePath?: string | null;
  /** Short reason code / text without secrets. */
  detail: string | null;
  checkedAt: number;
}

export interface AgentAvailability {
  agent: AgentKind;
  usable: boolean;
  reason: 'ok' | 'not-installed' | 'not-logged-in' | 'error';
}

/** One limit window of an agent's account usage (`hermes usage --json` windows[]). */
export interface AgentUsageWindow {
  label: string;
  /** 0..100 */
  usedPercent: number;
  /** epoch ms, null when unknown */
  resetsAt: number | null;
  detail: string | null;
}

/** Account usage of a non-Claude agent (statusline meters). */
export interface AgentUsageSnapshot {
  agent: AgentKind;
  provider: string | null;
  title: string | null;
  plan: string | null;
  windows: AgentUsageWindow[];
  /** epoch ms of the fetch */
  fetchedAt: number;
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
  /** Fixture / headless e2e run: the renderer shows no system notifications. */
  testMode: boolean;
  /** Local agent logins detected so far (cached; `agents:recheck` refreshes). */
  localAuth: LocalAuthInfo[];
  /** Latest usage per agent that has one (absent / null = hide the meters). */
  agentUsage: Partial<Record<AgentKind, AgentUsageSnapshot | null>>;
}

// ---------------------------------------------------------------------------
// App info / data / shared config
// ---------------------------------------------------------------------------

export interface AppInfo {
  appVersion: string;
  /** Bundled Claude Code CLI version (SDK manifest, or what a session reported). */
  cliVersion: string | null;
  /** @anthropic-ai/claude-agent-sdk package version. */
  sdkVersion: string | null;
  electronVersion: string;
  /** App data folder (state.json, thread logs, usage history). */
  dataDir: string;
}

export type SharedEntryState = 'linked' | 'not-linked' | 'broken' | 'conflict';

export interface SharedConfigEntry {
  /** Entry name under ~/.claude (SHARED_CONFIG_ENTRIES). */
  name: string;
  /** Present in ~/.claude (only present entries are linked). */
  inSource: boolean;
  /** Per-account state, keyed by account id. */
  byAccount: Record<string, SharedEntryState>;
}

export interface SharedConfigStatus {
  /** `~/.claude` (display with `~`). */
  sourceDir: string;
  entries: SharedConfigEntry[];
}

// ---------------------------------------------------------------------------
// Git (changes panel / commit flow)
// ---------------------------------------------------------------------------

/** M modified, A added (incl. untracked), D deleted, R renamed, U unmerged. */
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'U';

export interface GitChangedFile {
  /** Path relative to the thread cwd (repo-relative). */
  path: string;
  /** Previous path of a rename. */
  oldPath?: string;
  status: GitFileStatus;
  /** Not in git yet (never added). */
  untracked: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitChanges {
  /** false: the thread folder is not a git repository (nothing else is set). */
  isRepo: boolean;
  /** Checked-out branch of the thread cwd (`hopecode/<id>` in a worktree). */
  branch: string | null;
  /** Branch the worktree was cut from (project folder's branch); null outside a worktree. */
  baseBranch: string | null;
  /** Changes compared with the merge-base of `baseBranch` (worktree) or HEAD, including uncommitted work. */
  files: GitChangedFile[];
  /** Commits on `branch` not in `baseBranch`. */
  ahead: number;
  /** Uncommitted changes exist (tracked or untracked). */
  dirty: boolean;
}

export interface GitFileDiff {
  path: string;
  binary: boolean;
  hunks: StructuredPatchHunk[];
}

export interface GitRemoteInfo {
  /** `origin` (or the first remote); null when the repo has no remote. */
  remote: string | null;
  remoteUrl: string | null;
  /** Branch that would be pushed. */
  branch: string | null;
  /** PR base branch. */
  baseBranch: string | null;
  /** `gh` CLI found on the login-shell PATH. */
  ghAvailable: boolean;
}

export type GitActionResult<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Thread start (draft -> first send)
// ---------------------------------------------------------------------------

export interface ThreadStartRequest {
  /** Omitted = a chat without a project (scratch folder). */
  projectId?: string;
  text: string;
  /** Agent of the new thread (default 'claude-code'). */
  agent?: AgentKind;
  model?: string;
  permissionMode?: UiPermissionMode;
  /** Claude: EffortLevel; Codex: CodexEffortLevel. */
  effort?: EffortLevel | CodexEffortLevel | null;
  pinnedAccountId?: string | null;
  /** Start the worktree from this branch (a PR head) instead of the project's HEAD. */
  baseBranch?: string;
  /** PR number of `baseBranch`: fetched as `pull/<n>/head` when the branch is not on the remote (forks). */
  basePr?: number;
  /** Composer attachments (`attach:*` ids) sent with the first message. */
  attachmentIds?: string[];
}

/**
 * `ok: false` means nothing was created (no thread, no worktree): the first message could not be sent, and the
 * renderer keeps the draft text.
 */
export type ThreadStartResult =
  | { ok: true; thread: Thread; send: ChatSendResult }
  | { ok: false; reason: NonNullable<ChatSendResult['reason']> };

// ---------------------------------------------------------------------------
// Slash commands (composer `/` picker)
// ---------------------------------------------------------------------------

/**
 * Where a slash command comes from: `user` (~/.claude), `project` (<project>/.claude, trusted folders only),
 * `plugin` (an installed plugin), `builtin` (the agent's own command), `session` (reported by the live session
 * only, e.g. an MCP prompt or a claude.ai-synced skill).
 */
export type SlashCommandSource = 'user' | 'project' | 'plugin' | 'builtin' | 'session';

export interface SlashCommandInfo {
  /** Typed after the slash (`demo`, `plugin:skill`, `frontend:review`). */
  name: string;
  description: string;
  /** Frontmatter `argument-hint` / SDK `argumentHint`; null = the command takes no arguments. */
  argumentHint: string | null;
  source: SlashCommandSource;
  /** Plugin name for `plugin` commands. */
  plugin?: string;
  kind: 'skill' | 'command' | 'builtin';
  /** Absolute path of the SKILL.md / command file (preview only; never sent back to main). */
  path?: string;
  /** First lines of the body after the frontmatter (plain markdown text, capped). */
  preview?: string;
}

export interface SlashCommandList {
  commands: SlashCommandInfo[];
  /** `session`: merged with the live Query's supportedCommands(); `scan`: files only (draft / no session). */
  origin: 'session' | 'scan';
}
