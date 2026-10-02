// Scripted answers to 노트 모드 requests for fixture runs (fakeQuery; tests/fixtures/acp/fakeAcpAgent.mjs mirrors it).
// Deterministic per prompt kind, built from the request line, so e2e can check what landed where:
//  - inline (선택 수정 / 커서 위치 작성): the replacement text only.
//  - chat: a sentence, then a `note-*` card picked from the request:
//      "N번 섹션" / "'제목' 섹션"  -> note-replace of that heading (taken from the prompt's section list)
//      "전체"                      -> note-replace-all
//      "[chat]"                    -> no card (a plain answer)
//      anything else               -> note-insert with a short study note on the request
import { TASK_CHAT, TASK_INLINE_EDIT, TASK_INLINE_WRITE } from '../../core/notes/notePrompt';

export type NoteFixtureKind = 'chat' | 'inline-edit' | 'inline-write';

export interface ParsedNotePrompt {
  kind: NoteFixtureKind;
  request: string;
  /** Heading texts of the prompt's section list (`#` marks dropped). */
  headings: string[];
}

export function parseNotePrompt(prompt: string): ParsedNotePrompt {
  const kind: NoteFixtureKind = prompt.includes(`## 작업 (${TASK_INLINE_EDIT})`)
    ? 'inline-edit'
    : prompt.includes(`## 작업 (${TASK_INLINE_WRITE})`)
      ? 'inline-write'
      : 'chat';
  // The chat prompt ends with the request; the inline prompt has it in its own section.
  const request = (kind === 'chat' ? /## 요청\n([\s\S]*)$/.exec(prompt)?.[1] : /## 요청\n([^\n]*)/.exec(prompt)?.[1])?.trim() ?? '';
  const list = /## 섹션 목록\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? '';
  const headings = [...list.matchAll(/^\s*- #{1,6} (.*)$/gm)].map((m) => m[1].trim());
  return { kind, request, headings };
}

/** The heading a chat request names: "N번 섹션" (the heading numbered N) or a quoted title. */
export function fixtureSection(request: string, headings: readonly string[]): string | null {
  const n = /(\d+)번 섹션/.exec(request)?.[1];
  if (n) return headings.find((h) => h.startsWith(`${n}.`)) ?? `${n}. (없음)`;
  const quoted = /'([^']+)'\s*섹션/.exec(request)?.[1];
  return quoted ?? null;
}

/** Answer of the fixture engine; `tag` tells the engines apart in e2e (FIXTURE / CODEX). */
export function noteFixtureAnswer(prompt: string, tag = 'FIXTURE'): string {
  const { kind, request, headings } = parseNotePrompt(prompt);
  if (kind === 'inline-edit') return `${tag}-INLINE: ${request} 요청대로 고친 문장입니다.`;
  if (kind === 'inline-write') return `${tag}-WRITE: ${request} 내용을 커서 위치에 썼습니다.`;
  if (request.includes('[chat]')) return `${tag}-CHAT: ${request.replace('[chat]', '').trim()}에 대한 답입니다. 노트는 바꾸지 않았습니다.`;
  if (/섹션/.test(request)) {
    const section = fixtureSection(request, headings);
    const title = section ?? '없음';
    return [
      `'${title}' 섹션을 요청대로 고쳤습니다.`,
      '',
      `\`\`\`note-replace section="${title}"`,
      `### ${title}`,
      '',
      `${tag}-SECTION: ${request} 요청대로 다시 쓴 섹션입니다.`,
      '',
      '```java',
      'int example = 1;',
      '```',
      '```',
      '',
    ].join('\n');
  }
  if (/전체/.test(request)) {
    return [
      '문서 전체를 다시 썼습니다.',
      '',
      '```note-replace-all',
      '# 전체 수정본',
      '',
      `${tag}-REWRITE: ${request} 요청대로 문서 전체를 다시 썼습니다.`,
      '',
      '### 1. 정리',
      '',
      '- 다시 쓴 문서입니다.',
      '```',
      '',
    ].join('\n');
  }
  return [
    `${request} 노트 초안을 만들었습니다.`,
    '',
    '```note-insert',
    `# ${request}`,
    '',
    `${request}를 공부하기 위한 노트입니다. ${tag}가 스트리밍으로 쓴 본문입니다.`,
    '',
    '### 1. 핵심 개념',
    '',
    '- **정의**: fixture 정의입니다.',
    '- 동작: `fixture()` 호출로 동작합니다.',
    '',
    '```java',
    'int answer = 42;',
    '```',
    '',
    '### 2. 정리',
    '',
    '- fixture 정리입니다.',
    '```',
    '',
  ].join('\n');
}

/** Chunks of an answer (about 8), the way a model streams it. */
export function noteFixtureChunks(text: string, parts = 8): string[] {
  const size = Math.max(1, Math.ceil(text.length / parts));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
