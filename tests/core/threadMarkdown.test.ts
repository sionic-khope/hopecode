import { describe, expect, it } from 'vitest';
import { markdownFileName, threadToMarkdown, toolTarget } from '../../src/core/threadMarkdown';
import type { ChatItem } from '../../src/shared/types';

const at = 1_700_000_000_000;

const items: ChatItem[] = [
  { id: 'u1', type: 'user', createdAt: at, text: 'README 인사말을 바꿔 주세요 @README.md' },
  { id: 'a1', type: 'assistant-text', createdAt: at, text: 'I will update the README greeting.' },
  {
    id: 't1',
    type: 'tool',
    createdAt: at,
    toolUseId: 'toolu_1',
    name: 'Edit',
    input: { file_path: 'README.md', old_string: 'Hello world', new_string: 'Hello Hopecode' },
    result: 'The file README.md has been updated.',
  },
  { id: 't2', type: 'tool', createdAt: at, toolUseId: 'toolu_2', name: 'Bash', input: { command: 'echo `date`' }, result: 'x', isError: true },
  { id: 't3', type: 'tool', createdAt: at, toolUseId: 'toolu_3', name: 'Task', input: { subagent_type: 'general-purpose', description: '조사' } },
  { id: 'a2', type: 'assistant-text', createdAt: at, text: 'Done.\n\n```ts\nconst a = 1;\n```' },
  { id: 'n1', type: 'notice', createdAt: at, level: 'warn', text: '한도에 가까워졌습니다' },
  { id: 'u2', type: 'user', createdAt: at, text: '고마워요' },
];

describe('threadToMarkdown', () => {
  const md = threadToMarkdown({ title: 'README 수정', project: 'hopecode', agentName: 'Claude Code', exportedAt: at }, items);

  it('starts with the title and the thread facts', () => {
    expect(md.startsWith('# README 수정\n\n- 프로젝트: hopecode\n- 내보낸 시각: 2023-11-14 22:13 UTC\n')).toBe(true);
  });

  it('keeps user and agent text verbatim under turn headings', () => {
    expect(md).toContain('## 사용자\n\nREADME 인사말을 바꿔 주세요 @README.md');
    expect(md).toContain('## Claude Code\n\nI will update the README greeting.');
    expect(md).toContain('```ts\nconst a = 1;\n```');
    expect(md).toContain('## 사용자\n\n고마워요');
    // One agent heading for the whole run of text + tools.
    expect(md.match(/## Claude Code/g)).toHaveLength(1);
  });

  it('summarizes each tool call on one line (name, target, status) in a single list', () => {
    expect(md).toContain(
      '- 도구 **Edit** `README.md` (완료)\n- 도구 **Bash** `` echo `date` `` (실패)\n- 도구 **Task** `general-purpose · 조사` (실행 중)',
    );
    expect(md).not.toContain('has been updated');
    expect(md).not.toContain('Hello Hopecode');
  });

  it('quotes notices', () => {
    expect(md).toContain('> 경고: 한도에 가까워졌습니다');
  });

  it('falls back to a default agent name and omits missing facts', () => {
    const plain = threadToMarkdown({ title: 'T' }, [{ id: 'a', type: 'assistant-text', createdAt: at, text: 'hi' }]);
    expect(plain).toBe('# T\n\n## Claude\n\nhi\n');
  });
});

describe('toolTarget', () => {
  it('reads the file / command / pattern per tool', () => {
    expect(toolTarget({ name: 'Read', input: { file_path: '/x/a.ts' } })).toBe('/x/a.ts');
    expect(toolTarget({ name: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } })).toBe('n.ipynb');
    expect(toolTarget({ name: 'Grep', input: { pattern: 'foo', path: 'src' } })).toBe('foo · src');
    expect(toolTarget({ name: 'Unknown', input: { a: 1 } })).toBe('');
  });
});

describe('markdownFileName', () => {
  it('strips path and reserved characters', () => {
    expect(markdownFileName('a/b:c*d?')).toBe('a b c d.md');
    expect(markdownFileName('../../etc/passwd')).toBe('etc passwd.md');
    expect(markdownFileName('   ')).toBe('thread.md');
    expect(markdownFileName('x'.repeat(200))).toBe(`${'x'.repeat(80)}.md`);
  });
});
