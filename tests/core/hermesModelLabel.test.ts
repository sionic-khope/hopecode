import { describe, expect, it } from 'vitest';
import { hermesModelLabel } from '../../src/core/hermesModelLabel';

describe('hermesModelLabel', () => {
  it('formats vendor/model ids', () => {
    expect(hermesModelLabel('deepseek/deepseek-v4.1-flash-ultrafast', 'og')).toBe('DeepSeek V4.1 Flash Ultrafast');
    expect(hermesModelLabel('openai/gpt-6.1-sol')).toBe('GPT 6.1 Sol');
    expect(hermesModelLabel('z-ai/glm-5-air')).toBe('GLM 5 Air');
    expect(hermesModelLabel('moonshot/kimi-k3')).toBe('Kimi K3');
    expect(hermesModelLabel('qwen3-max')).toBe('Qwen3 Max');
    expect(hermesModelLabel('claude-opus-5-5')).toBe('Claude Opus 5 5');
  });
  it('keeps unknown shapes verbatim', () => {
    expect(hermesModelLabel('weird model!')).toBe('weird model!');
    expect(hermesModelLabel('vendor/')).toBe('vendor/');
  });
});
