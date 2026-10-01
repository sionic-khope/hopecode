import { describe, expect, it } from 'vitest';
import { parseHermesAuthList, parseHermesAuthStatus } from '../../src/core/hermesAuthParse';

describe('hermesAuthParse', () => {
  it('reads provider headers only', () => {
    const out = 'copilot (2 credentials):\n  - label-a  secret-ish\nopenai-codex (1 credential):\n  - x\nnoise line\n';
    expect(parseHermesAuthList(out)).toEqual([
      { id: 'copilot', count: 2 },
      { id: 'openai-codex', count: 1 },
    ]);
  });
  it('empty / garbage -> []', () => {
    expect(parseHermesAuthList('')).toEqual([]);
    expect(parseHermesAuthList('boom')).toEqual([]);
  });
  it('status', () => {
    expect(parseHermesAuthStatus('openai-codex: logged in\n')).toBe(true);
    expect(parseHermesAuthStatus('anthropic: logged out')).toBe(false);
    expect(parseHermesAuthStatus('???')).toBeNull();
  });
});
