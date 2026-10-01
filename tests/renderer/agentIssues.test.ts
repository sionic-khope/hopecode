import { describe, expect, it } from 'vitest';
import { describeAgentError, formatElapsed, splitAgentWarning } from '../../src/renderer/components/Chat/agentIssues';

describe('describeAgentError', () => {
  const kind = (raw: string) => describeAgentError(raw, 'Codex').kind;

  it('maps known failures to their Korean guidance', () => {
    expect(kind('Codex 로그인이 필요합니다. 터미널에서 `npx @openai/codex login`을 실행한 뒤 다시 보내세요.')).toBe('auth');
    expect(kind('모든 계정의 인증이 만료되었습니다. 계정 화면에서 다시 로그인하세요.')).toBe('auth');
    expect(kind('Codex 오류: 429 Too Many Requests')).toBe('rate-limit');
    expect(kind('Codex 오류: Rate limit reached for requests')).toBe('rate-limit');
    expect(kind('Codex 오류: Model metadata for `gpt-x` not found')).toBe('model-metadata');
    expect(kind('Codex가 응답하지 않습니다 (session/prompt 시간 초과).')).toBe('timeout');
    expect(kind('Codex 오류: stream disconnected before completion: error sending request')).toBe('network');
    expect(kind('Codex 오류: fetch failed')).toBe('network');
    expect(kind('Codex 프로세스가 종료되었습니다.\nfatal: token [redacted]')).toBe('crash');
    expect(kind('Claude Code가 예기치 않게 종료되었습니다.')).toBe('crash');
    expect(kind('Codex 실행 파일을 시작할 수 없습니다: ENOENT')).toBe('start');
  });

  it('falls back to the generic "응답 실패" copy', () => {
    const copy = describeAgentError('Codex 오류: Internal error', 'Codex');
    expect(copy).toMatchObject({ kind: 'unknown', title: 'Codex 응답 실패' });
    expect(copy.description).toContain('다시 시도');
  });

  it('a redacted token in a crash tail is not an auth error', () => {
    expect(kind('Codex 프로세스가 종료되었습니다.\nfatal: token [redacted]')).not.toBe('auth');
  });
});

describe('splitAgentWarning', () => {
  const line = 'Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';

  it('recognizes a whole-message model metadata warning', () => {
    const split = splitAgentWarning(line);
    expect(split?.rest).toBe('');
    expect(split?.warning.raw).toBe(line);
    expect(split?.warning.text).toContain('모델 메타데이터');
  });

  it('keeps the answer that follows the warning line', () => {
    expect(splitAgentWarning(`${line}\n\n안녕하세요`)?.rest).toBe('안녕하세요');
  });

  it('ignores ordinary answers and warnings in the middle of a text', () => {
    expect(splitAgentWarning('Hello there')).toBeNull();
    expect(splitAgentWarning(`Answer first.\n${line}`)).toBeNull();
    expect(splitAgentWarning('Model meta')).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('seconds, then minutes with padded seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(3_400)).toBe('3s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(-5)).toBe('0s');
  });
});
