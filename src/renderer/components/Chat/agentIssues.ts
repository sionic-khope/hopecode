// Pure classification of what agents report when a turn goes wrong (error card copy) and of warning text an agent
// streams as if it were an answer (shown as a warn notice instead). The raw text is already redacted by main.
import { t, type MessageKey } from '../../../shared/i18n';

export type AgentErrorKind = 'auth' | 'rate-limit' | 'model-metadata' | 'timeout' | 'network' | 'crash' | 'start' | 'unknown';

export interface AgentErrorCopy {
  kind: AgentErrorKind;
  title: string;
  description: string;
}

/**
 * First matching rule wins: specific causes before the generic ones they could also match (timeout before network).
 * Main reports in the UI language, so each rule also knows how the app's own messages read in en / ja / zh-Hans.
 */
const ERROR_RULES: readonly { kind: Exclude<AgentErrorKind, 'unknown'>; test: RegExp }[] = [
  {
    kind: 'auth',
    test: /로그인이 필요|인증이 만료|인증(?:에)? 실패|ログインが必要|認証の有効期限が切れ|認証に失敗|需要登录|认证已过期|认证失败|login required|unauthori[sz]ed|authentication (?:required|failed|has expired)|not logged in|invalid[_ ]api[_ ]key|token (?:has )?expired|\b401\b/i,
  },
  { kind: 'rate-limit', test: /rate[ _-]?limit|too many requests|usage limit|limit reached|quota|한도(?:에)? 도달|上限に達|达到.{0,4}上限|\b429\b/i },
  { kind: 'model-metadata', test: /model metadata|model[_ ]not[_ ]found|unknown model|model .{1,80} (?:not found|does not exist)/i },
  { kind: 'timeout', test: /시간 초과|タイムアウト|超时|timed? ?out|timeout|deadline exceeded/i },
  {
    kind: 'network',
    test: /network|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|stream disconnected|connection (?:reset|refused|closed|error)/i,
  },
  { kind: 'start', test: /실행 파일을 시작할 수 없|시작하지 못했습니다|起動できません|起動に失敗|无法启动|启动失败|cannot start|failed to start|ENOENT|EACCES|spawn/i },
  { kind: 'crash', test: /프로세스가 종료|예기치 않게 종료|중지되었습니다|プロセスが終了|予期せず終了|停止しました|进程已退出|意外退出|已停止|exited|crash|SIGKILL|SIGSEGV|SIGTERM/i },
];

/** Title + explanation (current language) for an error notice of an `agentName` thread. Unknown messages get the generic copy. */
export function describeAgentError(raw: string, agentName: string): AgentErrorCopy {
  const kind = ERROR_RULES.find((r) => r.test.test(raw))?.kind ?? 'unknown';
  switch (kind) {
    case 'auth':
      return {
        kind,
        title: t('agentError.auth', { agent: agentName }),
        description: t('agentError.auth.desc'),
      };
    case 'rate-limit':
      return {
        kind,
        title: t('agentError.rateLimit'),
        description: t('agentError.rateLimit.desc'),
      };
    case 'model-metadata':
      return {
        kind,
        title: t('agentError.model'),
        description: t('agentError.model.desc', { agent: agentName }),
      };
    case 'timeout':
      return {
        kind,
        title: t('agentError.timeout'),
        description: t('agentError.timeout.desc', { agent: agentName }),
      };
    case 'network':
      return {
        kind,
        title: t('agentError.network'),
        description: t('agentError.network.desc'),
      };
    case 'start':
      return {
        kind,
        title: t('agentError.start', { agent: agentName }),
        description: t('agentError.start.desc'),
      };
    case 'crash':
      return {
        kind,
        title: t('agentError.crash', { agent: agentName }),
        description: t('agentError.crash.desc'),
      };
    default:
      return {
        kind: 'unknown',
        title: t('agentError.unknown', { agent: agentName }),
        description: t('agentError.unknown.desc'),
      };
  }
}

export interface AgentWarning {
  /** Notice text (current language). */
  text: string;
  /** The agent's own line (shown small under the notice). */
  raw: string;
}

/** Warning lines agents print into the answer stream. Each matches from the start of the text. */
const WARNING_RULES: readonly { test: RegExp; text: MessageKey }[] = [
  {
    // codex: "Model metadata for `gpt-x` not found. Defaulting to fallback metadata; this can degrade performance…"
    test: /^\s*(?:warning:\s*)?model metadata for\b[^\n]*/i,
    text: 'agentWarning.modelMetadata',
  },
];

/**
 * Splits a leading agent warning off assistant text: `{ warning, rest }` where `rest` is the answer that followed
 * (possibly ''). `null` when the text does not start with a known warning. A streaming prefix of a warning
 * ("Model meta") is not matched yet; it becomes a warning once the line is recognizable.
 */
export function splitAgentWarning(text: string): { warning: AgentWarning; rest: string } | null {
  for (const rule of WARNING_RULES) {
    const m = rule.test.exec(text);
    if (!m) continue;
    const raw = m[0].trim();
    const rest = text.slice(m.index + m[0].length).replace(/^\s+/, '');
    return { warning: { text: t(rule.text), raw }, rest };
  }
  return null;
}

/** "3s", "59s", "1m 05s", "12m 00s". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
