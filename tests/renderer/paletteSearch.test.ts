import { describe, expect, it } from 'vitest';
import { searchPalette, toChoseong, type PaletteItem } from '../../src/renderer/components/Palette/paletteSearch';

function item(id: string, title: string, extra: Partial<PaletteItem> = {}): PaletteItem {
  return { id, title, group: extra.group ?? '명령', ...extra };
}

const ids = (items: readonly PaletteItem[], q: string, limit?: number) => searchPalette(items, q, limit).map((m) => m.item.id);

describe('searchPalette: empty query', () => {
  const items = [item('b', 'Beta', { group: 'x' }), item('a', 'Alpha', { group: 'y' }), item('c', 'Gamma', { group: 'x' })];

  it('returns items in their given order with score 0 and no ranges', () => {
    const res = searchPalette(items, '');
    expect(res.map((m) => m.item.id)).toEqual(['b', 'a', 'c']);
    expect(res.every((m) => m.score === 0 && m.ranges.length === 0)).toBe(true);
  });

  it('treats whitespace-only as empty and honors limit', () => {
    expect(ids(items, '   ')).toEqual(['b', 'a', 'c']);
    expect(ids(items, '', 2)).toEqual(['b', 'a']);
  });
});

describe('searchPalette: tier ordering', () => {
  it('ranks exact > prefix > word-start > substring > keywords/subtitle > fuzzy', () => {
    const items = [
      item('fuzzy', 'The error map'), // t..e..r..m subsequence only
      item('meta', 'Open shell', { keywords: ['term'] }),
      item('sub', 'Autoterminate'), // substring mid-word
      item('word', 'Show term-list'), // word start
      item('prefix', 'Terminal'),
      item('exact', 'Term'),
      item('none', 'Settings'),
    ];
    expect(ids(items, 'term')).toEqual(['exact', 'prefix', 'word', 'sub', 'meta', 'fuzzy']);
  });

  it('is case-insensitive and trims the query', () => {
    const items = [item('a', 'New Thread')];
    expect(ids(items, '  NEW thr ')).toEqual(['a']);
    expect(searchPalette(items, '  NEW THREAD  ')[0]!.ranges).toEqual([[0, 10]]);
  });

  it('treats -, _, ., / and spaces as word separators', () => {
    const items = [item('mid', 'xxfoo'), item('dash', 'a-foo'), item('under', 'a_foo'), item('dot', 'a.foo'), item('slash', 'a/foo')];
    expect(ids(items, 'foo')).toEqual(['dash', 'under', 'dot', 'slash', 'mid']);
  });

  it('matches subtitle and keywords but produces no title highlight', () => {
    const items = [item('s', 'Open project', { subtitle: '~/code/hopecode' }), item('k', 'Switch account', { keywords: ['login', 'profile'] })];
    const bySub = searchPalette(items, 'hopecode');
    expect(bySub.map((m) => m.item.id)).toEqual(['s']);
    expect(bySub[0]!.ranges).toEqual([]);
    expect(ids(items, 'PROFILE')).toEqual(['k']);
  });

  it('excludes items that match nothing', () => {
    expect(ids([item('a', 'Alpha'), item('b', 'Beta')], 'zzz')).toEqual([]);
  });
});

describe('searchPalette: multi-word AND', () => {
  const items = [
    item('nt', 'New Thread'),
    item('nw', 'New Window'),
    item('ot', 'Open Thread', { keywords: ['recent'] }),
  ];

  it('requires every word to match somewhere', () => {
    expect(ids(items, 'new thread')).toEqual(['nt']);
    expect(ids(items, 'thread new')).toEqual(['nt']);
    expect(ids(items, 'new zzz')).toEqual([]);
  });

  it('lets different words match different fields', () => {
    expect(ids(items, 'thread recent')).toEqual(['ot']);
  });

  it('merges highlight ranges from every word', () => {
    expect(searchPalette(items, 'thr new')[0]!.ranges).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });
});

describe('searchPalette: fuzzy subsequence', () => {
  it('matches in-order chars with gaps and highlights each run', () => {
    const res = searchPalette([item('a', 'Toggle Sidebar')], 'tgsb');
    expect(res).toHaveLength(1);
    expect(res[0]!.ranges).toEqual([
      [0, 1],
      [2, 3],
      [7, 8],
      [11, 12],
    ]);
  });

  it('rejects out-of-order chars', () => {
    expect(ids([item('a', 'Toggle Sidebar')], 'bst')).toEqual([]);
  });

  it('penalizes gaps: a tighter subsequence ranks higher', () => {
    const items = [item('loose', 'c-x-x-x-x-m-x-x-x-d'), item('tight', 'cxmxd')];
    expect(ids(items, 'cmd')).toEqual(['tight', 'loose']);
  });

  it('picks the tightest window rather than the first greedy one', () => {
    const res = searchPalette([item('a', 'ab xxxx abc')], 'abc');
    expect(res[0]!.ranges).toEqual([[8, 11]]);
  });
});

describe('searchPalette: Korean', () => {
  it('extracts choseong for Hangul syllables and keeps other chars', () => {
    expect(toChoseong('설정')).toBe('ㅅㅈ');
    expect(toChoseong('새 스레드 v2')).toBe('ㅅ ㅅㄹㄷ v2');
    expect(toChoseong('까치')).toBe('ㄲㅊ');
  });

  it('matches 초성 queries and highlights the matching syllables', () => {
    const items = [item('set', '설정'), item('new', '새 스레드'), item('acc', '계정 전환')];
    const res = searchPalette(items, 'ㅅㅈ');
    expect(res.map((m) => m.item.id)).toEqual(['set']);
    expect(res[0]!.ranges).toEqual([[0, 2]]);
    expect(ids(items, 'ㅅㄹㄷ')).toEqual(['new']);
    expect(searchPalette(items, 'ㅅㄹㄷ')[0]!.ranges).toEqual([[2, 5]]);
    expect(ids(items, 'ㄱㅈ ㅈㅎ')).toEqual(['acc']);
  });

  it('supports plain Hangul substring matching', () => {
    const items = [item('a', '스레드 이름 변경'), item('b', '새 스레드'), item('c', '설정')];
    expect(ids(items, '스레드')).toEqual(['a', 'b']);
    expect(searchPalette(items, '이름')[0]!.ranges).toEqual([[4, 6]]);
  });

  it('does not treat syllable queries as choseong', () => {
    expect(ids([item('a', '설정')], '서')).toEqual([]);
  });
});

describe('searchPalette: limit and stability', () => {
  it('keeps original order for equal scores', () => {
    const items = [item('3', 'Copy path'), item('1', 'Copy link'), item('2', 'Copy id')];
    expect(ids(items, 'copy')).toEqual(['3', '1', '2']);
  });

  it('applies limit after ranking', () => {
    const items = [item('sub', 'xxab'), item('pre', 'abc'), item('pre2', 'abd')];
    expect(ids(items, 'ab', 2)).toEqual(['pre', 'pre2']);
    expect(ids(items, 'ab', 0)).toEqual([]);
  });

  it('returns prefix highlight ranges', () => {
    expect(searchPalette([item('a', 'Settings')], 'set')[0]!.ranges).toEqual([[0, 3]]);
  });
});
