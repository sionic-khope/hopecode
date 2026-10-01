// Scripted answers to 노트 모드 requests for fixture runs (fakeQuery; tests/fixtures/acp/fakeAcpAgent.mjs mirrors it).
// Deterministic markdown per mode, built from the request line, so e2e can check what landed in the editor.

/** The `## 요청` line and the mode of a note prompt (buildNoteUserPrompt). */
export function parseNotePrompt(prompt: string): { mode: 'write' | 'section' | 'rewrite'; request: string; targetHeading: string | null } {
  const mode = /## 작업 \(이 섹션\)/.test(prompt) ? 'section' : /## 작업 \(전체 수정\)/.test(prompt) ? 'rewrite' : 'write';
  const request = /## 요청\n([^\n]*)/.exec(prompt)?.[1]?.trim() ?? '';
  const target = /<target>\n([\s\S]*?)<\/target>/.exec(prompt)?.[1] ?? '';
  const targetHeading = /^(#{1,6} .*)$/m.exec(target)?.[1] ?? null;
  return { mode, request, targetHeading };
}

export function noteFixtureAnswer(prompt: string): string {
  const { mode, request, targetHeading } = parseNotePrompt(prompt);
  if (mode === 'section') {
    return `${targetHeading ?? '### 고친 범위'}\n\nFIXTURE-SECTION: ${request} 요청대로 다시 쓴 섹션이다.\n`;
  }
  if (mode === 'rewrite') {
    return `# 전체 수정본\n\nFIXTURE-REWRITE: ${request} 요청대로 문서 전체를 다시 썼다.\n\n### 1. 정리\n\n- 다시 쓴 문서다.\n`;
  }
  return [
    `# ${request}`,
    '',
    `${request}를 공부하기 위한 노트다. fixture가 스트리밍으로 쓴 본문이다.`,
    '',
    '### 1. 핵심 개념',
    '',
    '- **정의**: fixture 정의다.',
    '- 동작: `fixture()` 호출로 동작한다.',
    '',
    '```java',
    'int answer = 42;',
    '```',
    '',
    '### 2. 정리',
    '',
    '- fixture 정리다.',
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
