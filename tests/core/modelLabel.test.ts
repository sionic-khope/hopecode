import { describe, expect, it } from 'vitest';
import { modelLabel } from '../../src/core/modelLabel';

describe('modelLabel', () => {
  it('derives family + version from SDK model ids', () => {
    expect(modelLabel('claude-fable-5')).toBe('Fable 5');
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('opus')).toBe('Opus');
  });

  it('prefers an exact models:list entry and leaves unknown ids unchanged', () => {
    expect(modelLabel('fable', [{ value: 'fable', label: 'Fable (latest)' }])).toBe('Fable (latest)');
    expect(modelLabel('mystery-model')).toBe('mystery-model');
  });
});
