import { describe, expect, it } from 'vitest';
import { redact } from '../../src/core/redact';

describe('redact', () => {
  it('masks sk- keys, JWTs and Bearer tokens', () => {
    expect(redact('key sk-abcdEFGH12345678 end')).toBe('key [redacted] end');
    expect(redact('sk-proj-abc_DEF-123456789')).toBe('[redacted]');
    expect(redact('t eyJhbGciOiJub25lIn0.eyJlbWFpbCI6InhAeS56In0.sig_nature x')).toBe('t [redacted] x');
    expect(redact('Authorization: Bearer abc.def-123_456==')).toBe('Authorization: [redacted]');
  });

  it('masks long hex and base64 runs', () => {
    expect(redact(`id ${'a1b2c3d4'.repeat(4)} done`)).toBe('id [redacted] done');
    expect(redact(`blob ${'Ab1+'.repeat(12)}== end`)).toBe('blob [redacted] end');
  });

  it('leaves ordinary text and paths alone', () => {
    const text = '/Users/me/Desktop/project/src/core/something/very/long/directory/name/file.ts: 에러 발생 (code 12)';
    expect(redact(text)).toBe(text);
    expect(redact('')).toBe('');
  });
});

describe('redact (headers, key/value, provider prefixes)', () => {
  it('masks Bearer and Basic credentials; leaves "Basic" as a word', () => {
    expect(redact('Bearer abcDEF123.xyz')).toBe('[redacted]');
    expect(redact(`header Basic ${btoa('user:pass')} end`)).toBe('header [redacted] end');
    expect(redact('Basic configuration done')).toBe('Basic configuration done');
  });

  it('key/value pairs keep the key and mask the value', () => {
    expect(redact('api_key=abc123 next')).toBe('api_key=[redacted] next');
    expect(redact('access_token: "zzz"')).toBe('access_token: "[redacted]"');
    expect(redact('{"refresh_token":"r-1","other":1}')).toBe('{"refresh_token":"[redacted]","other":1}');
    expect(redact('password=hunter2&user=x')).toBe('password=[redacted]&user=x');
    expect(redact('SECRET = shh')).toBe('SECRET = [redacted]');
    expect(redact('token=t0k')).toBe('token=[redacted]');
    expect(redact('authorization: Basic Zm9vOmJhcg==')).toBe('authorization: [redacted]');
  });

  it('prefixed secret keys are masked; similar non-secret keys are not', () => {
    expect(redact('ANTHROPIC_AUTH_TOKEN=abc123xyz')).toBe('ANTHROPIC_AUTH_TOKEN=[redacted]');
    expect(redact('session_token: s3ss')).toBe('session_token: [redacted]');
    expect(redact('client_secret=cs')).toBe('client_secret=[redacted]');
    expect(redact('export OPENROUTER_API_KEY="or-key"')).toBe('export OPENROUTER_API_KEY="[redacted]"');
    expect(redact('max_tokens=4096 tokens: 12 password_hint=x')).toBe('max_tokens=4096 tokens: 12 password_hint=x');
  });

  it('masks Google keys and provider-prefixed tokens', () => {
    expect(redact(`k AIza${'Sy0_a-B'.repeat(5)} k`)).toBe('k [redacted] k');
    for (const t of ['sk-abcdefgh12', 'rt_abcdefgh12', 'xai-abcdefghij', 'gsk_abcdefghij', 'ghp_abcdefghij', 'gho_abcdefghij', 'github_pat_abcdefghij']) {
      expect(redact(`x ${t} y`)).toBe('x [redacted] y');
    }
  });

  it('is linear on long runs (no ReDoS): 64KB without digits under 50ms', () => {
    const inputs = ['z'.repeat(64 * 1024), 'xy-_+'.repeat(13_200), `${'Q'.repeat(64 * 1024)}!`, `${'a'.repeat(64 * 1024)}g`, `token=${' '.repeat(64 * 1024)}`, '_'.repeat(64 * 1024), 'a_'.repeat(32 * 1024)];
    for (const input of inputs) {
      const started = performance.now();
      const out = redact(input);
      expect(performance.now() - started).toBeLessThan(50);
      expect(out).toBe(input);
    }
  });
});
