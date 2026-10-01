import { describe, expect, it } from 'vitest';
import {
  applySlashChoice,
  claudeBadge,
  expandSlashLabel,
  filterSlashCommands,
  fromAcp,
  fromClaude,
  sendsOnEnter,
  slashTokenAt,
  type SlashItem,
} from '../../src/renderer/components/Chat/slashCommands';

const item = (name: string, description = '', argumentHint: string | null = null): SlashItem => ({
  name,
  label: name,
  description,
  argumentHint,
  source: 'user',
  badge: 'user',
});

describe('slashTokenAt', () => {
  it('finds a slash at the input start or a line start, up to the caret', () => {
    expect(slashTokenAt('/de', 3)).toEqual({ start: 0, end: 3, query: 'de', atInputStart: true });
    expect(slashTokenAt('/', 1)).toEqual({ start: 0, end: 1, query: '', atInputStart: true });
    expect(slashTokenAt('hi\n/rev more', 7)).toEqual({ start: 3, end: 7, query: 'rev', atInputStart: false });
  });

  it('none mid-line, after whitespace, or with the caret before the slash', () => {
    expect(slashTokenAt('a /de', 5)).toBeNull();
    expect(slashTokenAt('/demo arg', 9)).toBeNull();
    expect(slashTokenAt('/demo', 0)).toBeNull();
    expect(slashTokenAt('', 0)).toBeNull();
  });
});

describe('filterSlashCommands (fuzzy)', () => {
  const items = [item('compact', 'Summarize'), item('clear', 'Wipe history'), item('oh-my:review', 'Review code'), item('demo', 'Demo skill')];

  it('empty query keeps the order', () => {
    expect(filterSlashCommands(items, '').map((i) => i.name)).toEqual(['compact', 'clear', 'oh-my:review', 'demo']);
  });

  it('prefix beats word start beats subsequence; descriptions match too', () => {
    expect(filterSlashCommands(items, 'c').map((i) => i.name).slice(0, 2)).toEqual(['compact', 'clear']);
    expect(filterSlashCommands(items, 'rev')[0]!.name).toBe('oh-my:review');
    expect(filterSlashCommands(items, 'cmpt').map((i) => i.name)).toEqual(['compact']);
    expect(filterSlashCommands(items, 'wipe').map((i) => i.name)).toEqual(['clear']);
    expect(filterSlashCommands(items, 'zzz')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(filterSlashCommands(items, '', 2)).toHaveLength(2);
  });
});

describe('choosing a row', () => {
  it('replaces the token with "/name " and keeps the rest', () => {
    const t = slashTokenAt('/de', 3)!;
    expect(applySlashChoice('/de', t, 'demo')).toEqual({ text: '/demo ', caret: 6 });
    const t2 = slashTokenAt('/de rest', 3)!;
    expect(applySlashChoice('/de rest', t2, 'demo')).toEqual({ text: '/demo rest', caret: 6 });
    const t3 = slashTokenAt('intro\n/c', 8)!;
    expect(applySlashChoice('intro\n/c', t3, 'clear').text).toBe('intro\n/clear ');
  });

  it('Enter sends at once only for an argument-less command that is the whole message', () => {
    const t = slashTokenAt('/cl', 3)!;
    expect(sendsOnEnter(item('clear'), '/cl', t)).toBe(true);
    expect(sendsOnEnter(item('demo', '', '<topic>'), '/cl', t)).toBe(false);
    const mid = slashTokenAt('hi\n/cl', 6)!;
    expect(sendsOnEnter(item('clear'), 'hi\n/cl', mid)).toBe(false);
    const withRest = slashTokenAt('/cl\nmore', 3)!;
    expect(sendsOnEnter(item('clear'), '/cl\nmore', withRest)).toBe(false);
  });
});

describe('plugin short labels', () => {
  const info = (name: string, plugin?: string) =>
    ({ name, description: '', argumentHint: null, source: plugin ? 'plugin' : 'user', ...(plugin ? { plugin } : {}), kind: 'skill' }) as const;

  it('shows the short name when unique, keeps the full one when it collides', () => {
    const items = fromClaude([
      info('oh-my-claudecode:ultragoal', 'oh-my-claudecode'),
      info('oh-my-claudecode:plan', 'oh-my-claudecode'),
      info('other:plan', 'other'),
      info('demo'),
    ]);
    expect(items.map((i) => i.label)).toEqual(['ultragoal', 'oh-my-claudecode:plan', 'other:plan', 'demo']);
    expect(filterSlashCommands(items, 'ultra')[0]?.name).toBe('oh-my-claudecode:ultragoal');
    // The plugin name stays searchable.
    expect(filterSlashCommands(items, 'oh-my').map((i) => i.name)).toContain('oh-my-claudecode:ultragoal');
  });

  it('expands a short label to the namespaced name on send, leaves everything else alone', () => {
    const items = fromClaude([info('oh-my-claudecode:ultragoal', 'oh-my-claudecode'), info('demo')]);
    expect(expandSlashLabel('/ultragoal ship it', items)).toBe('/oh-my-claudecode:ultragoal ship it');
    expect(expandSlashLabel('/ultragoal', items)).toBe('/oh-my-claudecode:ultragoal');
    expect(expandSlashLabel('/demo x', items)).toBe('/demo x');
    expect(expandSlashLabel('/ultragoalx', items)).toBe('/ultragoalx');
    expect(expandSlashLabel('hi /ultragoal', items)).toBe('hi /ultragoal');
  });
});

describe('badges', () => {
  it('labels sources', () => {
    expect(claudeBadge({ source: 'plugin', plugin: 'omc' })).toBe('omc');
    expect(claudeBadge({ source: 'builtin' })).toBe('Claude 내장');
    expect(claudeBadge({ source: 'project' })).toBe('project');
    expect(fromAcp([{ name: 'review', description: 'r', hint: 'x' }], 'Codex')[0]).toMatchObject({ badge: 'Codex 내장', argumentHint: 'x' });
  });
});
