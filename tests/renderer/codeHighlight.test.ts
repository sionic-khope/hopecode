import { describe, expect, it } from 'vitest';
import { findLanguage, highlightTokens } from '../../src/renderer/components/Chat/codeHighlight';

describe('codeHighlight', () => {
  it('finds a language by fence name and colours keywords, strings and comments', async () => {
    const desc = findLanguage('ts');
    expect(desc?.name).toBe('TypeScript');
    const support = await desc!.load();
    const code = "export const a = 'x'; // note\n";
    const tokens = highlightTokens(code, support.language)!;
    expect(tokens.map((t) => t.text).join('')).toBe(code);
    expect(tokens.find((t) => t.text === 'export')?.cls).toContain('tok-keyword');
    expect(tokens.find((t) => t.text === "'x'")?.cls).toContain('tok-string');
    expect(tokens.find((t) => t.text === '// note')?.cls).toContain('tok-comment');
  });

  it('handles a legacy stream-mode language and unknown names', async () => {
    const shell = findLanguage('sh');
    expect(shell).not.toBeNull();
    const support = await shell!.load();
    const tokens = highlightTokens('echo "hi" # c', support.language);
    expect(tokens?.map((t) => t.text).join('')).toBe('echo "hi" # c');
    expect(findLanguage('text')).toBeNull();
    expect(findLanguage(null)).toBeNull();
  });
});
