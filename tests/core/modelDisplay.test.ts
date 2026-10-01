import { describe, expect, it } from 'vitest';
import {
  FALLBACK_DEFAULT_MODEL_LABEL,
  codexModelLabel,
  concreteModelLabel,
  defaultModelLabelFrom,
  defaultModelLabelFromOptions,
  isModelSelected,
  modelMenuLabel,
} from '../../src/core/modelDisplay';
import { FALLBACK_MODELS } from '../../src/shared/constants';
import type { ModelOption } from '../../src/shared/types';

/** Shape of a live supportedModels() answer (SDK labels, `default` resolving to Opus 5.5 on this account). */
const LIVE: ModelOption[] = [
  { value: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
  { value: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1', resolvedModel: 'claude-fable-5-1' },
  { value: 'sonnet', label: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
  { value: 'haiku', label: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001' },
];

describe('model display names', () => {
  it('the fallback list is the current lineup and default runs as Fable 5.1', () => {
    expect(FALLBACK_DEFAULT_MODEL_LABEL).toBe('Fable 5.1');
    expect(FALLBACK_MODELS.map((m) => m.label)).toEqual(['Default', 'Fable 5.1', 'Opus 5.5', 'Sonnet 5', 'Haiku 4.5']);
    expect(defaultModelLabelFromOptions(FALLBACK_MODELS)).toBe('Fable 5.1');
  });

  it('versions aliases and resolves default', () => {
    expect(concreteModelLabel('fable', FALLBACK_MODELS)).toBe('Fable 5.1');
    expect(concreteModelLabel('claude-fable-5-1', FALLBACK_MODELS)).toBe('Fable 5.1');
    expect(concreteModelLabel('opus', FALLBACK_MODELS)).toBe('Opus 5.5');
    expect(concreteModelLabel('sonnet', [{ value: 'sonnet', label: 'Sonnet' }])).toBe('Sonnet 5');
    expect(concreteModelLabel('haiku', [])).toBe('Haiku 4.5');
    expect(concreteModelLabel('default', FALLBACK_MODELS)).toBe('Fable 5.1');
    expect(concreteModelLabel('default', [], { defaultLabel: 'Opus 5.5' })).toBe('Opus 5.5');
  });

  it('SDK labels win over the built-in alias table', () => {
    const sdk: ModelOption[] = [{ value: 'fable', label: 'Fable 6', resolvedModel: 'claude-fable-6' }];
    expect(concreteModelLabel('fable', sdk)).toBe('Fable 6');
    expect(concreteModelLabel('default', LIVE)).toBe('Opus 5.5');
    expect(concreteModelLabel('sonnet', [], { resolvedModel: 'claude-sonnet-5' })).toBe('Sonnet 5');
    expect(concreteModelLabel('fable', LIVE, { resolvedModel: 'claude-fable-5-1' })).toBe('Fable 5.1');
  });

  it('prefers the id a session resolved, then versioned option labels, then the id itself', () => {
    expect(concreteModelLabel('default', [], { resolvedModel: 'claude-sonnet-5' })).toBe('Sonnet 5');
    expect(concreteModelLabel('sonnet', [], { resolvedModel: 'sonnet' })).toBe('Sonnet 5');
    expect(concreteModelLabel('x', [{ value: 'x', label: 'Custom 2' }])).toBe('Custom 2');
    expect(concreteModelLabel('claude-opus-5-5', [])).toBe('Opus 5.5');
    expect(concreteModelLabel('mystery', [{ value: 'mystery', label: 'Mystery' }])).toBe('Mystery');
  });

  it('labels the default menu row with what it runs as', () => {
    expect(modelMenuLabel('default', FALLBACK_MODELS)).toBe('기본 (Fable 5.1)');
    expect(modelMenuLabel('default', LIVE)).toBe('기본 (Opus 5.5)');
    expect(modelMenuLabel('default', FALLBACK_MODELS, 'Opus 5.5')).toBe('기본 (Opus 5.5)');
    expect(modelMenuLabel('claude-fable-5-1', FALLBACK_MODELS)).toBe('Fable 5.1');
  });

  it('learns the default model from the SDK list first, then the newest thread that resolved it', () => {
    expect(defaultModelLabelFrom([])).toBe(FALLBACK_DEFAULT_MODEL_LABEL);
    const threads = [
      { model: 'default', resolvedModel: 'claude-opus-5-5', updatedAt: 1 },
      { model: 'default', resolvedModel: 'claude-sonnet-5', updatedAt: 2 },
      { model: 'fable', resolvedModel: 'claude-fable-5-1', updatedAt: 3 },
    ];
    expect(defaultModelLabelFrom(threads)).toBe('Sonnet 5');
    expect(defaultModelLabelFrom(threads, LIVE)).toBe('Opus 5.5');
    // A list without a resolved default row does not override what sessions reported.
    expect(defaultModelLabelFrom(threads, [{ value: 'default', label: 'Default' }])).toBe('Sonnet 5');
  });
});

describe('full-id model values', () => {
  it('labels a stored full id with the row that resolves to it', () => {
    expect(concreteModelLabel('claude-opus-5-5', FALLBACK_MODELS)).toBe('Opus 5.5');
    expect(concreteModelLabel('claude-opus-5-5', LIVE)).toBe('Opus 5.5');
  });

  it('checks rows by resolvedModel, exact value first, never the default row', () => {
    const opus = LIVE[1]!;
    const def = LIVE[0]!;
    expect(isModelSelected('opus', opus, LIVE)).toBe(true);
    expect(isModelSelected('claude-opus-5-5', opus, LIVE)).toBe(true);
    expect(isModelSelected('claude-opus-5-5', def, LIVE)).toBe(false);
    expect(isModelSelected('claude-opus-5-5', LIVE[3]!, LIVE)).toBe(false);
    const twin: ModelOption = { value: 'opus-twin', label: 'Opus twin', resolvedModel: 'claude-opus-5-5' };
    const rows = [...LIVE, twin];
    expect(isModelSelected('claude-opus-5-5', opus, rows)).toBe(true);
    expect(isModelSelected('claude-opus-5-5', twin, rows)).toBe(false);
    expect(isModelSelected('opus-twin', twin, rows)).toBe(true);
    expect(isModelSelected('opus-twin', opus, rows)).toBe(false);
    // An exact value row wins over a resolvedModel match.
    const exact: ModelOption = { value: 'claude-opus-5-5', label: 'Opus 5.5 pinned', resolvedModel: 'claude-opus-5-5' };
    expect(isModelSelected('claude-opus-5-5', opus, [...LIVE, exact])).toBe(false);
    expect(isModelSelected('claude-opus-5-5', exact, [...LIVE, exact])).toBe(true);
  });

  it('labels Codex models from config options, then the built-in table', () => {
    const opts = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue: 'gpt-6-sol',
        options: [{ value: 'gpt-6-sol', name: 'GPT-6 Sol (agent)' }],
      },
    ];
    expect(codexModelLabel('gpt-6-sol', opts)).toBe('GPT-6 Sol (agent)');
    expect(codexModelLabel('gpt-6-sol')).toBe('GPT-6-Sol');
    expect(codexModelLabel('other-model')).toBe('other-model');
  });
});

describe('codexModelLabel with agents that echo raw ids as names', () => {
  it('prefers the versioned label when the option name equals its value', () => {
    const opts = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-6-sol', options: [{ value: 'gpt-6-sol', name: 'gpt-6-sol' }] }] as never;
    expect(codexModelLabel('gpt-6-sol', opts)).toBe('GPT-6-Sol');
  });
  it('keeps a real agent-provided name', () => {
    const opts = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-6-sol', options: [{ value: 'gpt-6-sol', name: 'GPT 6 Sol (fast)' }] }] as never;
    expect(codexModelLabel('gpt-6-sol', opts)).toBe('GPT 6 Sol (fast)');
  });
});
