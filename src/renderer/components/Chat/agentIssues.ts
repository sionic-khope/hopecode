// Pure classification of what agents report when a turn goes wrong (error card copy) and of warning text an agent
// streams as if it were an answer (shown as a warn notice instead). The raw text is already redacted by main.

export type AgentErrorKind = 'auth' | 'rate-limit' | 'model-metadata' | 'timeout' | 'network' | 'crash' | 'start' | 'unknown';

export interface AgentErrorCopy {
  kind: AgentErrorKind;
  title: string;
  description: string;
}

/** First matching rule wins: specific causes before the generic ones they could also match (timeout before network). */
const ERROR_RULES: readonly { kind: Exclude<AgentErrorKind, 'unknown'>; test: RegExp }[] = [
  {
    kind: 'auth',
    test: /로그인이 필요|인증이 만료|인증(?:에)? 실패|unauthori[sz]ed|authentication (?:required|failed)|not logged in|invalid[_ ]api[_ ]key|token (?:has )?expired|\b401\b/i,
  },
  { kind: 'rate-limit', test: /rate[ _-]?limit|too many requests|usage limit|quota|한도(?:에)? 도달|\b429\b/i },
  { kind: 'model-metadata', test: /model metadata|model[_ ]not[_ ]found|unknown model|model .{1,80} (?:not found|does not exist)/i },
  { kind: 'timeout', test: /시간 초과|timed? ?out|timeout|deadline exceeded/i },
  {
    kind: 'network',
    test: /network|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|stream disconnected|connection (?:reset|refused|closed|error)/i,
  },
  { kind: 'start', test: /실행 파일을 시작할 수 없|시작하지 못했습니다|ENOENT|EACCES|spawn/i },
  { kind: 'crash', test: /프로세스가 종료|예기치 않게 종료|중지되었습니다|exited|crash|SIGKILL|SIGSEGV|SIGTERM/i },
];

/** Korean title + explanation for an error notice of an `agentName` thread. Unknown messages get the generic copy. */
export function describeAgentError(raw: string, agentName: string): AgentErrorCopy {
  const kind = ERROR_RULES.find((r) => r.test.test(raw))?.kind ?? 'unknown';
  switch (kind) {
    case 'auth':
      return {
        kind,
        title: `${agentName} 로그인 필요`,
        description: '로그인이 필요하거나 인증이 만료되었습니다. 다시 로그인한 뒤 시도하세요.',
      };
    case 'rate-limit':
      return {
        kind,
        title: '사용 한도에 도달함',
        description: '요청이 너무 많거나 사용 한도에 도달했습니다. 잠시 기다린 뒤 다시 시도하세요.',
      };
    case 'model-metadata':
      return {
        kind,
        title: '모델 정보를 찾지 못함',
        description: `${agentName}가 선택한 모델을 알지 못합니다. 모델을 바꾸거나 에이전트를 업데이트한 뒤 다시 시도하세요.`,
      };
    case 'timeout':
      return {
        kind,
        title: '응답 시간 초과',
        description: `${agentName}가 제때 응답하지 않았습니다. 다시 시도하거나 새 세션에서 시도해 보세요.`,
      };
    case 'network':
      return {
        kind,
        title: '네트워크 오류',
        description: '서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.',
      };
    case 'start':
      return {
        kind,
        title: `${agentName}를 시작하지 못함`,
        description: '에이전트 실행 파일을 시작하지 못했습니다. 설치와 로그인 상태를 확인한 뒤 다시 시도하세요.',
      };
    case 'crash':
      return {
        kind,
        title: `${agentName} 프로세스 종료`,
        description: '에이전트 프로세스가 예기치 않게 종료되었습니다. 다시 시도하면 새 프로세스로 이어갑니다.',
      };
    default:
      return {
        kind: 'unknown',
        title: `${agentName} 응답 실패`,
        description: '에이전트가 요청을 처리하지 못했습니다. 다시 시도하거나 새 세션에서 시도해 보세요.',
      };
  }
}

export interface AgentWarning {
  /** Korean notice text. */
  text: string;
  /** The agent's own line (shown small under the notice). */
  raw: string;
}

/** Warning lines agents print into the answer stream. Each matches from the start of the text. */
const WARNING_RULES: readonly { test: RegExp; text: string }[] = [
  {
    // codex: "Model metadata for `gpt-x` not found. Defaulting to fallback metadata; this can degrade performance…"
    test: /^\s*(?:warning:\s*)?model metadata for\b[^\n]*/i,
    text: '모델 메타데이터를 찾지 못해 기본값으로 실행합니다. 응답 품질이나 기능이 제한될 수 있습니다.',
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
    return { warning: { text: rule.text, raw }, rest };
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
