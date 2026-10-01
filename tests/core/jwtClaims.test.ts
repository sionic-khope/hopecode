import { describe, expect, it } from 'vitest';
import { decodeJwtClaims } from '../../src/core/jwtClaims';

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload: unknown) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;

describe('decodeJwtClaims', () => {
  it('reads email, plan and exp', () => {
    expect(
      decodeJwtClaims(
        jwt({ email: '한글@example.com', exp: 1790000000, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
      ),
    ).toEqual({ email: '한글@example.com', plan: 'plus', exp: 1790000000 });
  });

  it('returns nulls for missing or mistyped claims', () => {
    expect(decodeJwtClaims(jwt({}))).toEqual({ email: null, plan: null, exp: null });
    expect(decodeJwtClaims(jwt({ email: 1, exp: '5', 'https://api.openai.com/auth': 'x' }))).toEqual({
      email: null,
      plan: null,
      exp: null,
    });
  });

  it('returns null (never throws) for malformed input', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', 'a..c', 'a.!!!.c', `a.${b64url('str')}.c`, `a.${b64url([1])}.c`, 'a.bm90IGpzb24.c']) {
      expect(decodeJwtClaims(bad)).toBeNull();
    }
    expect(decodeJwtClaims(undefined as unknown as string)).toBeNull();
    expect(decodeJwtClaims(null as unknown as string)).toBeNull();
  });
});
