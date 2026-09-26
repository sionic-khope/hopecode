import { describe, expect, it } from 'vitest';
import { collectSources, collectSubagents, countSubagents, mentionsIn, relativeToCwd } from '../../src/renderer/components/Env/collectEnv';
import type { ChatItem, ToolItem } from '../../src/shared/types';

const CWD = '/repo/wt';
let n = 0;
function tool(name: string, input: Record<string, unknown>, extra: Partial<ToolItem> = {}): ToolItem {
  n += 1;
  return { id: `t${n}`, type: 'tool', createdAt: n, toolUseId: `toolu_${n}`, name, input, ...extra };
}
const user = (text: string): ChatItem => ({ id: `u${++n}`, type: 'user', createdAt: n, text });

describe('collectSubagents', () => {
  it('lists Task / Agent calls with type, description and status', () => {
    const items: ChatItem[] = [
      tool('Task', { subagent_type: 'general-purpose', description: '저장소 조사' }, { result: 'ok' }),
      tool('Read', { file_path: 'a.ts' }, { result: 'x' }),
      tool('Agent', { subagent_type: 'code-reviewer' }, { result: 'boom', isError: true }),
      tool('Task', { description: '  ' }),
    ];
    const list = collectSubagents(items);
    expect(list.map((s) => [s.agentType, s.description, s.status])).toEqual([
      ['general-purpose', '저장소 조사', 'done'],
      ['code-reviewer', null, 'failed'],
      [null, null, 'running'],
    ]);
    expect(list[0]!.toolUseId).toBe((items[0] as ToolItem).toolUseId);
    expect(countSubagents(list)).toEqual({ running: 1, done: 1, failed: 1 });
  });

  it('is empty without subagent calls', () => {
    expect(collectSubagents([user('hi'), tool('Bash', { command: 'ls' })])).toEqual([]);
  });
});

describe('mentionsIn', () => {
  it('finds plain and quoted @ mentions, not e-mail addresses', () => {
    expect(mentionsIn('see @src/a.ts, and @"docs/my file.md" (mail me@x.com)\n@b.md')).toEqual(['src/a.ts', 'docs/my file.md', 'b.md']);
  });
});

describe('relativeToCwd', () => {
  it('maps paths inside the thread folder and drops the rest', () => {
    expect(relativeToCwd('/repo/wt/src/a.ts', CWD)).toBe('src/a.ts');
    expect(relativeToCwd('./src/a.ts', CWD)).toBe('src/a.ts');
    expect(relativeToCwd('src/a.ts', `${CWD}/`)).toBe('src/a.ts');
    expect(relativeToCwd('/repo/wt2/a.ts', CWD)).toBeNull();
    expect(relativeToCwd('/etc/passwd', CWD)).toBeNull();
    expect(relativeToCwd('../x', CWD)).toBeNull();
    expect(relativeToCwd('~/x', CWD)).toBeNull();
    expect(relativeToCwd('/repo/wt', CWD)).toBeNull();
  });
});

describe('collectSources', () => {
  it('collects mentions and file tools, most recent first, merged per path', () => {
    const items: ChatItem[] = [
      user('look at @README.md and @/etc/hosts'),
      tool('Read', { file_path: '/repo/wt/src/a.ts' }),
      tool('Edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' }),
      tool('Grep', { pattern: 'x', path: 'src' }),
      tool('NotebookEdit', { notebook_path: '/repo/wt/nb.ipynb' }),
      tool('Write', { file_path: '/elsewhere/z.ts' }),
      tool('Read', { file_path: '/repo/wt/src/a.ts' }),
    ];
    expect(collectSources(items, CWD)).toEqual([
      { path: 'src/a.ts', kinds: ['read'] },
      { path: 'nb.ipynb', kinds: ['edit'] },
      { path: 'README.md', kinds: ['edit', 'mention'] },
    ]);
  });

  it('is empty when nothing was referenced', () => {
    expect(collectSources([user('hello'), tool('Bash', { command: 'ls' })], CWD)).toEqual([]);
  });
});
