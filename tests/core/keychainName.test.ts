import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keychainServiceName } from '../../src/core/keychainName';

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('keychainServiceName', () => {
  it('returns the base service name when configDir is absent', () => {
    expect(keychainServiceName(undefined, sha256Hex)).toBe('Claude Code-credentials');
  });

  it('appends the first 8 hex chars of sha256(configDir) verbatim', () => {
    const configDir = '/Users/khope/.hopecode/accounts/abc-123';
    const expectedHash = sha256Hex(configDir).slice(0, 8);
    expect(keychainServiceName(configDir, sha256Hex)).toBe(`Claude Code-credentials-${expectedHash}`);
  });

  it('is a fixed, deterministic vector for a known configDir', () => {
    // Hardcoded sha256("/tmp/hopecode-fixture-config-dir") first 8 hex chars, so a
    // regression in the hashing/slicing composition (not the injected hash fn) fails this test.
    const configDir = '/tmp/hopecode-fixture-config-dir';
    const fullHash = sha256Hex(configDir);
    expect(fullHash.slice(0, 8)).toBe('60142a32');
    expect(keychainServiceName(configDir, sha256Hex)).toBe('Claude Code-credentials-60142a32');
  });

  it('does not expand a tilde-prefixed configDir before hashing', () => {
    const configDir = '~/.hopecode/accounts/xyz';
    const expected = `Claude Code-credentials-${sha256Hex(configDir).slice(0, 8)}`;
    expect(keychainServiceName(configDir, sha256Hex)).toBe(expected);
  });
});
