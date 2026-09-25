import { describe, expect, it } from 'vitest';
import {
  FALLBACK_DEFAULT_MODEL_LABEL,
  concreteModelLabel,
  defaultModelLabelFrom,
  modelMenuLabel,
} from '../../src/core/modelDisplay';
import { FALLBACK_MODELS } from '../../src/shared/constants';

describe('model display names', () => {
  it('versions aliases and resolves default', () => {
    expect(concreteModelLabel('fable', FALLBACK_MODELS)).toBe('Fable 5');
    expect(concreteModelLabel('opus', FALLBACK_MODELS)).toBe('Opus 5.5');
    expect(concreteModelLabel('sonnet', [{ value: 'sonnet', label: 'Sonnet' }])).toBe('Sonnet 5');
    expect(concreteModelLabel('haiku', [])).toBe('Haiku 4.5');
    expect(concreteModelLabel('default', FALLBACK_MODELS)).toBe(FALLBACK_DEFAULT_MODEL_LABEL);
    expect(concreteModelLabel('default', [], { defaultLabel: 'Opus 5.5' })).toBe('Opus 5.5');
  });

  it('prefers the id a session resolved, then versioned option labels, then the id itself', () => {
    expect(concreteModelLabel('default', [], { resolvedModel: 'claude-sonnet-5' })).toBe('Sonnet 5');
    expect(concreteModelLabel('sonnet', [], { resolvedModel: 'sonnet' })).toBe('Sonnet 5');
    expect(concreteModelLabel('x', [{ value: 'x', label: 'Custom 2' }])).toBe('Custom 2');
    expect(concreteModelLabel('claude-opus-5-5', [])).toBe('Opus 5.5');
    expect(concreteModelLabel('mystery', [{ value: 'mystery', label: 'Mystery' }])).toBe('Mystery');
  });

  it('labels the default menu row with what it runs as', () => {
    expect(modelMenuLabel('default', FALLBACK_MODELS)).toBe(`기본 (${FALLBACK_DEFAULT_MODEL_LABEL})`);
    expect(modelMenuLabel('default', FALLBACK_MODELS, 'Opus 5.5')).toBe('기본 (Opus 5.5)');
    expect(modelMenuLabel('fable', FALLBACK_MODELS)).toBe('Fable 5');
  });

  it('learns the default model from the newest thread that resolved it', () => {
    expect(defaultModelLabelFrom([])).toBe(FALLBACK_DEFAULT_MODEL_LABEL);
    expect(
      defaultModelLabelFrom([
        { model: 'default', resolvedModel: 'claude-opus-5-5', updatedAt: 1 },
        { model: 'default', resolvedModel: 'claude-sonnet-5', updatedAt: 2 },
        { model: 'fable', resolvedModel: 'claude-fable-5', updatedAt: 3 },
      ]),
    ).toBe('Sonnet 5');
  });
});
