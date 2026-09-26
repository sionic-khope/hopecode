import type { AppSettings, EffortLevel, ModelOption, UiPermissionMode } from './types';

export const APP_NAME = 'Hopecode';
/** Value prefix for CLAUDE_AGENT_SDK_CLIENT_APP (`hopecode/<version>`). */
export const CLIENT_APP_NAME = 'hopecode';

/** Retry prompt after a rate-limited turn that already produced output (plan 7.2 M5). */
export const CONTINUE_PROMPT = 'Continue the previous task from where it stopped.';

export const UI_PERMISSION_MODES: readonly UiPermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
];

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Title of a thread before its first message names it. */
export const DEFAULT_THREAD_TITLE = '새 채팅';
/** Auto titles (first user message) are cut to this many characters. */
export const THREAD_TITLE_MAX_CHARS = 40;

/** "New Task Start" default request template (settings' 일반 section resets to this). */
export const DEFAULT_NEW_TASK_TEMPLATE = `작업 시작 전에 다음을 순서대로 해 주세요.
1. git pull로 base 브랜치를 최신 상태로 맞추기
2. 이번 작업용 worktree와 branch 만들기
3. CLAUDE.md, context.md를 읽고 프로젝트 규칙과 컨텍스트 파악하기
4. 최근 변경사항(CHANGES.md 또는 git log 최근 커밋) 확인하기
5. 파악한 내용을 짧게 요약하고 다음 지시를 기다리기`;
/** `newTaskTemplate` upper bound (settings:update). */
export const NEW_TASK_TEMPLATE_MAX_CHARS = 4000;

/**
 * Model list shown until the SDK reported one (startup probe cache or a live session). Values mirror the CLI's
 * supportedModels() rows; `default` runs as Fable 5.1 until a session says otherwise.
 */
export const FALLBACK_MODELS: readonly ModelOption[] = [
  { value: 'default', label: 'Default', description: '권장 모델', resolvedModel: 'claude-fable-5-1' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1', description: '가장 어려운 작업', resolvedModel: 'claude-fable-5-1' },
  { value: 'opus', label: 'Opus 5.5', description: '복잡하고 긴 작업', resolvedModel: 'claude-opus-5-5' },
  { value: 'sonnet', label: 'Sonnet 5', description: '빠른 일상 작업', resolvedModel: 'claude-sonnet-5' },
  { value: 'haiku', label: 'Haiku 4.5', description: '가장 빠른 응답', resolvedModel: 'claude-haiku-4-5-20251001' },
];

// Usage poll interval bounds (settings, seconds).
export const USAGE_POLL_MIN_SEC = 60;
export const USAGE_POLL_MAX_SEC = 300;
export const USAGE_POLL_DEFAULT_SEC = 90;
/** idleCloseMinutes bounds (0 = never close). */
export const IDLE_CLOSE_MAX_MINUTES = 240;

export const DEFAULT_SETTINGS: AppSettings = {
  idleCloseMinutes: 10,
  defaultModel: 'default',
  defaultPermissionMode: 'default',
  defaultEffort: null,
  useWorktree: true,
  autoSwitchAccounts: true,
  usagePollIntervalSec: USAGE_POLL_DEFAULT_SEC,
  notifications: true,
  defaultEditor: null,
  tosNoticeAcknowledged: false,
  newTaskTemplate: DEFAULT_NEW_TASK_TEMPLATE,
};

/** Startup model probe: give up on `initializationResult()` after this long (the cached / fallback list stays). */
export const MODEL_PROBE_TIMEOUT_MS = 30_000;

/** Account color palette (plan 5.3). */
export const ACCOUNT_COLORS: readonly string[] = [
  '#007AFF',
  '#34C759',
  '#FF9500',
  '#AF52DE',
  '#FF2D55',
  '#5AC8FA',
  '#FFCC00',
  '#A2845E',
];

// Meter thresholds (percent)
export const METER_WARN_PERCENT = 70;
export const METER_CRIT_PERCENT = 90;

// Time
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// Usage polling (plan 0.2)
export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const USAGE_BETA_HEADER = 'oauth-2025-04-20';
export const USAGE_FETCH_TIMEOUT_MS = 10_000;
export const USAGE_POLL_INTERVAL_MS = 90_000; // = USAGE_POLL_DEFAULT_SEC
export const USAGE_POLL_JITTER_MS = 10_000;
export const USAGE_RATE_LIMIT_BACKOFF_MAX_MS = 5 * MINUTE_MS;
export const USAGE_NETWORK_BACKOFF_MS = 2 * MINUTE_MS;
export const USAGE_STALE_AFTER_MS = 15 * MINUTE_MS;
/** Block duration when a rejection carries no reset time. */
export const FALLBACK_BLOCK_MS = 5 * MINUTE_MS;
export const CLI_VERSION_PATTERN = /^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/;

// Usage history
export const USAGE_HISTORY_RETENTION_MS = 14 * DAY_MS;
export const USAGE_SAMPLE_MIN_INTERVAL_MS = 5 * MINUTE_MS;

// Keychain
export const KEYCHAIN_SERVICE_BASE = 'Claude Code-credentials';
export const KEYCHAIN_TIMEOUT_MS = 2_000;

// Session
/** Injected via Options.settings (flag layer) so account transcripts are not swept after 30 days. */
export const SESSION_CLEANUP_PERIOD_DAYS = 3650;
export const WAIT_TICK_MS = 60_000;

// Shell / pty
export const SHELL_ENV_TIMEOUT_MS = 5_000;
export const FALLBACK_PATH_ENTRIES: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin'];
export const PTY_RING_BUFFER_BYTES = 256 * 1024;
export const TERMINAL_TERM = 'xterm-256color';

/** Entries of ~/.claude shared into each account config dir via symlink (only if present). */
export const SHARED_CONFIG_ENTRIES: readonly string[] = [
  'CLAUDE.md',
  'settings.json',
  'plugins',
  'hooks',
  'skills',
  'agents',
  'output-styles',
];

// Env
export const ENV_HOPECODE_HOME = 'HOPECODE_HOME';
export const ENV_FIXTURES = 'HOPECODE_FIXTURES';
export const ENV_FIXTURE_PROJECT = 'HOPECODE_FIXTURE_PROJECT';
export const ENV_SMOKE = 'HOPECODE_SMOKE';
/** Headless e2e: hidden window, no dock icon, never focuses, native dialogs auto-answered (unpackaged only). */
export const ENV_E2E = 'HOPECODE_E2E';
export const ENV_RENDERER_URL = 'ELECTRON_RENDERER_URL';

// Validation
/** Ids used as file names (thread logs, usage history). */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** SDK session ids (used in transcript paths). */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// External links
/** Hosts the login flow may open automatically (exact host or subdomain of the `*.` entries). */
export const LOGIN_URL_HOSTS: readonly string[] = ['claude.ai', 'claude.com', '*.anthropic.com'];

/** before-quit graceful dispose budget; afterwards Queries are aborted and the app exits. */
export const QUIT_DISPOSE_TIMEOUT_MS = 5_000;
