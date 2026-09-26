import { describe, expect, it } from 'vitest';
import { modelLabel } from '../../src/core/modelLabel';
import type { ModelOption } from '../../src/shared/types';

describe('modelLabel', () => {
  it('derives family + version from SDK model ids', () => {
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
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

  it('uses the SDK label of the row that resolves to the id (not the default row)', () => {
    const options: ModelOption[] = [
      { value: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
      { value: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
      { value: 'claude-fable-5-1', label: 'Fable 5.1', resolvedModel: 'claude-fable-5-1' },
      { value: 'haiku', label: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001' },
    ];
    expect(modelLabel('claude-opus-5-5', options)).toBe('Opus 5.5');
    expect(modelLabel('claude-fable-5-1', options)).toBe('Fable 5.1');
    expect(modelLabel('claude-haiku-4-5-20251001', options)).toBe('Haiku 4.5');
    // A future id the table does not know still gets a derived name.
    expect(modelLabel('claude-fable-6', options)).toBe('Fable 6');
  });
});
