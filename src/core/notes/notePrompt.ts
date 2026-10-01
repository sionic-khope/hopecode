// 노트 모드 AI requests: the writing rules (system prompt) and the per-request prompt. Pure.
// The rules describe a study-note format and a plain Korean register; no sample text from the user's notes is
// embedded here (the style references are read from the vault per request and capped).
import type { NoteAiMode } from '../../shared/notes';

/** First line of the system prompt (fixtures recognise a note request by it). */
export const NOTE_PROMPT_HEAD = '너는 학습 노트를 쓰는 기술 문서 작성자다.';

/** Phrases the output must not contain (AI-sounding filler). Listed in the prompt and checked in tests. */
export const BANNED_PHRASES: readonly string[] = [
  '좋은 질문입니다',
  '좋은 질문이에요',
  '~해 보겠습니다',
  '살펴보겠습니다',
  '알아보겠습니다',
  '결론적으로 요약하면',
  '요약하자면',
  '도움이 되었길 바랍니다',
  '궁금한 점이 있다면',
  '물론입니다',
  '흥미로운',
  '매우 중요합니다',
];

/** Lines of each style reference note sent with a request. */
export const STYLE_REF_MAX_LINES = 60;
/** Characters of each style reference (after the line cut). */
export const STYLE_REF_MAX_CHARS = 4_000;
/** Style references per request. */
export const STYLE_REF_MAX_FILES = 2;
/** Characters of the document sent as context (the rest is cut in the middle). */
export const DOCUMENT_MAX_CHARS = 60_000;
/** Characters of the user's request. */
export const REQUEST_MAX_CHARS = 8_000;

export const NOTE_MODE_LABEL: Record<NoteAiMode, string> = {
  write: '작성',
  section: '이 섹션',
  rewrite: '전체 수정',
};

export function buildNoteSystemPrompt(): string {
  return [
    NOTE_PROMPT_HEAD,
    '사용자가 공부하면서 다시 읽을 마크다운 학습 노트를 쓴다.',
    '',
    '## 포맷',
    '- `#` 제목 한 줄로 시작한다(문서 전체를 쓸 때만). 제목은 주제를 그대로 쓴다.',
    '- 제목 바로 아래에 개요를 둔다: 무엇을 배우는지, 왜 필요한지, 어떤 상황에서 문제가 되는지 2~4문장으로 쓴다.',
    '- 본문은 `### 1. 소제목`처럼 번호를 붙인 섹션으로 나눈다. 섹션마다 한 가지 개념만 다룬다.',
    '- 핵심 개념은 정의 → 동작 방식 → 예시 순서로 설명한다.',
    '- 코드 예시는 언어를 명시한 코드 블록(```java, ```kotlin, ```sql 등)으로 쓰고, 꼭 필요한 줄만 넣는다. 코드 안 주석도 한국어 평서체로 쓴다.',
    '- 선택지가 있는 주제는 장단점과 트레이드오프를 리스트나 표로 비교한다.',
    '- 마지막 섹션은 `### 정리`로, 기억할 내용을 짧은 리스트로 묶는다.',
    '- 리스트, 표, 인용, 코드 블록 같은 마크다운 문법만 쓴다. HTML 태그는 쓰지 않는다.',
    '',
    '## 문체',
    '- 한국어 평서체 "~다", "~이다"로 쓴다. 존댓말("~합니다", "~해요")은 쓰지 않는다.',
    '- 기술 용어는 영어 원어를 그대로 쓴다(예: lock, replication, failover, transaction). 처음 나올 때만 필요하면 괄호로 한국어를 덧붙인다.',
    '- 담백하게 설명한다. 독자에게 말을 걸지 않고, 감탄하거나 과장하지 않는다.',
    '- 서론("이번 글에서는", "~에 대해 알아보자")과 맺음말("도움이 되었길")을 쓰지 않는다. 첫 문장부터 내용이다.',
    '- 이모지, 느낌표, 굵은 글씨 남발을 쓰지 않는다. 굵은 글씨는 핵심 용어 정의에만 쓴다.',
    `- 다음 표현은 쓰지 않는다: ${BANNED_PHRASES.map((p) => `"${p}"`).join(', ')}.`,
    '',
    '## 출력',
    '- 요청한 범위에 들어갈 마크다운 본문만 출력한다.',
    '- 출력 전체를 코드펜스(```)로 감싸지 않는다.',
    '- 출력 앞뒤에 설명, 인사, 확인 문장("다음은 ~입니다", "수정했습니다")을 붙이지 않는다.',
    '- 도구를 쓰지 않는다. 파일을 읽거나 쓰지 않는다. 텍스트만 답한다.',
  ].join('\n');
}

export interface NotePromptInput {
  mode: NoteAiMode;
  request: string;
  /** Vault-relative path of the note (its folder hints at the subject area). */
  notePath: string;
  /** The whole note as the editor holds it. */
  document: string;
  /** 이 섹션: the text being replaced. */
  target: string | null;
  /** Openings of other notes in the same folder (already capped by `styleRefExcerpt`). */
  styleRefs: readonly { path: string; excerpt: string }[];
}

/** First STYLE_REF_MAX_LINES lines of a note, at most STYLE_REF_MAX_CHARS characters. */
export function styleRefExcerpt(text: string): string {
  const lines = text.split('\n').slice(0, STYLE_REF_MAX_LINES).join('\n');
  return lines.length > STYLE_REF_MAX_CHARS ? lines.slice(0, STYLE_REF_MAX_CHARS) : lines;
}

/** Long documents keep their start and end (the middle is replaced by a marker line). */
export function clipDocument(text: string, max = DOCUMENT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[… 중간 ${text.length - max}자 생략 …]\n\n${text.slice(-half)}`;
}

const MODE_TASK: Record<NoteAiMode, string> = {
  write: '요청한 주제로 학습 노트를 새로 쓴다. 출력은 현재 문서의 커서 위치에 그대로 들어간다. 문서가 비어 있으면 제목부터 쓰고, 이미 내용이 있으면 앞뒤 흐름에 맞는 섹션만 쓴다.',
  section: '아래 "대상 범위"만 요청대로 고쳐 쓴다. 출력은 대상 범위를 통째로 대체한다. 대상 범위의 제목 줄(있다면)과 heading 수준을 유지하고, 범위 밖의 내용은 출력하지 않는다.',
  rewrite: '문서 전체를 요청대로 다시 쓴다. 출력은 문서 전체를 대체한다. 원래 내용 중 맞는 정보는 살리고 포맷과 문체 규칙에 맞게 정리한다.',
};

export function buildNoteUserPrompt(input: NotePromptInput): string {
  const parts: string[] = [];
  parts.push(`## 작업 (${NOTE_MODE_LABEL[input.mode]})`, MODE_TASK[input.mode], '');
  parts.push('## 요청', input.request.slice(0, REQUEST_MAX_CHARS).trim(), '');
  parts.push(`## 노트 경로`, input.notePath, '');
  if (input.styleRefs.length > 0) {
    parts.push('## 같은 폴더의 다른 노트 (문체와 구성만 참고하고 내용은 옮기지 않는다)');
    for (const ref of input.styleRefs.slice(0, STYLE_REF_MAX_FILES)) {
      parts.push(`<reference path="${ref.path.replace(/"/g, '')}">`, ref.excerpt, '</reference>');
    }
    parts.push('');
  }
  const doc = input.document.trim() ? clipDocument(input.document) : '(빈 문서)';
  parts.push('## 현재 문서', '<document>', doc, '</document>');
  if (input.mode === 'section') {
    parts.push('', '## 대상 범위', '<target>', input.target ?? '', '</target>');
  }
  parts.push('', '마크다운 본문만 출력한다.');
  return parts.join('\n');
}

/**
 * Final cleanup of a streamed answer: a whole-output code fence (```markdown … ```) is unwrapped and surrounding
 * blank lines / trailing whitespace dropped. Anything else is kept as written.
 */
export function cleanNoteOutput(text: string): string {
  const fenced = /^\s*```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```\s*$/i.exec(text);
  const body = fenced ? fenced[1] : text;
  return body.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}
