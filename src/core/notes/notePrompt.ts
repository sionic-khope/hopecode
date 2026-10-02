// 노트 모드 AI requests: the writing rules (system prompt) and the per-request prompts of the conversation pane and
// the inline prompt. Pure. The rules describe a study-note format and a polite Korean register (~합니다/~입니다); no sample text from the
// user's notes is embedded here (style references are read from the vault per request and capped).
import { headingLines } from './noteEdit';

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
/** Earlier conversation rows sent with a chat request (newest kept). */
export const HISTORY_MAX_ITEMS = 8;
/** Characters of each earlier row (a chat answer "이거 노트로 작성해 줘" points at must fit whole). */
export const HISTORY_ITEM_MAX_CHARS = 6_000;
/** Characters of the selection an inline request rewrites. */
export const SELECTION_MAX_CHARS = 20_000;
/** Characters of text before / after the selection sent as its surroundings. */
export const CONTEXT_BEFORE_CHARS = 4_000;
export const CONTEXT_AFTER_CHARS = 2_000;

/** Section headers fixtures key on (`## 작업 (대화)` / `## 작업 (선택 수정)` / `## 작업 (커서 위치 작성)`). */
export const TASK_CHAT = '대화';
export const TASK_INLINE_EDIT = '선택 수정';
export const TASK_INLINE_WRITE = '커서 위치 작성';

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
    '- 코드 예시는 언어를 명시한 코드 블록(```java, ```kotlin, ```sql 등)으로 쓰고, 꼭 필요한 줄만 넣는다. 코드 안 주석은 한국어로 짧게 쓴다.',
    '- 선택지가 있는 주제는 장단점과 트레이드오프를 리스트나 표로 비교한다.',
    '- 마지막 섹션은 `### 정리`로, 기억할 내용을 짧은 리스트로 묶는다.',
    '- 리스트, 표, 인용, 코드 블록 같은 마크다운 문법만 쓴다. HTML 태그는 쓰지 않는다.',
    '',
    '## 문체',
    '- 한국어 존댓말 "~합니다", "~입니다"로 쓴다. 평서체("~다", "~이다")와 해요체("~해요")는 쓰지 않는다.',
    '- 리스트 항목이나 표 셀처럼 짧은 구절은 명사형으로 끝내도 된다. 문장으로 끝낼 때는 "~합니다", "~입니다"로 끝낸다.',
    '- 기술 용어는 영어 원어를 그대로 쓴다(예: lock, replication, failover, transaction). 처음 나올 때만 필요하면 괄호로 한국어를 덧붙인다.',
    '- 담백한 실무 문어체로 설명한다. 독자에게 말을 걸지 않고, 감탄하거나 과장하지 않는다.',
    '- 서론("이번 글에서는", "~에 대해 알아보자")과 맺음말("도움이 되었길")을 쓰지 않는다. 첫 문장부터 내용이다.',
    '- 이모지, 느낌표, 굵은 글씨 남발을 쓰지 않는다. 굵은 글씨는 핵심 용어 정의에만 쓴다.',
    `- 다음 표현은 쓰지 않는다: ${BANNED_PHRASES.map((p) => `"${p}"`).join(', ')}.`,
    '',
    '## 공통',
    '- 도구를 쓰지 않는다. 파일을 읽거나 쓰지 않는다. 텍스트만 답한다.',
    '- 위 포맷과 문체 규칙은 노트에 들어갈 본문에 적용한다. 본문 전체를 마크다운 코드펜스로 감싸지 않는다.',
    '- 대화 문장도 존댓말("~합니다", "~입니다")로 짧게 쓰고, 위에서 금지한 표현을 쓰지 않는다.',
  ].join('\n');
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

export interface NoteStyleRef {
  path: string;
  excerpt: string;
}

export interface NoteHistoryRow {
  role: 'user' | 'assistant';
  text: string;
}

export interface NoteChatPromptInput {
  request: string;
  /** Vault-relative path of the note (its folder hints at the subject area). */
  notePath: string;
  /** The whole note as the editor holds it. */
  document: string;
  /** Earlier turns of this note's conversation, oldest first (cards already folded into short markers). */
  history: readonly NoteHistoryRow[];
  /** Openings of other notes in the same folder (already capped by `styleRefExcerpt`). */
  styleRefs: readonly NoteStyleRef[];
}

export interface NoteInlinePromptInput {
  request: string;
  notePath: string;
  document: string;
  /** The range of `document` to rewrite (from === to: write new text at the caret). */
  selection: { from: number; to: number };
  styleRefs: readonly NoteStyleRef[];
}

function pushStyleRefs(parts: string[], refs: readonly NoteStyleRef[]): void {
  if (refs.length === 0) return;
  parts.push('## 같은 폴더의 다른 노트 (문체와 구성만 참고하고 내용은 옮기지 않는다)');
  for (const ref of refs.slice(0, STYLE_REF_MAX_FILES)) {
    parts.push(`<reference path="${ref.path.replace(/"/g, '')}">`, ref.excerpt, '</reference>');
  }
  parts.push('');
}

/** The note's headings as a list, so the model names a section exactly as it is written. */
function outline(doc: string): string {
  const heads = headingLines(doc);
  if (heads.length === 0) return '(heading 없음)';
  return heads
    .slice(0, 80)
    .map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${'#'.repeat(h.level)} ${h.title}`)
    .join('\n');
}

/**
 * The reply format of a conversation turn (parsed by core/notes/noteReply.ts). The model decides: a chat answer by
 * default, note blocks only when the user asked for the note to be written or changed. The client adds no guessing of
 * its own; a note block is written into the editor as it streams.
 */
export const NOTE_REPLY_RULES: readonly string[] = [
  '기본은 채팅 답이다. 질문, 설명, 계획, 커리큘럼, 목차, 요약, 비교처럼 노트에 쓰라는 말이 없는 요청은 일반 마크다운(제목, 표, 리스트, 코드 블록)으로 채팅에 전부 답한다. 블록에 넣거나 일부만 보여 주지 않는다.',
  '사용자가 노트에 쓰거나 고치라고 명시했을 때만 note 블록을 쓴다(예: "작성해 줘", "써 줘", "노트에 넣어 줘", "정리해서 문서로", "고쳐 줘", "수정해 줘", "2번 섹션 늘려 줘"). 블록 안의 본문은 에디터에 바로 반영된다.',
  '커리큘럼이나 목차 요청도 "노트에 넣어 달라", "작성해 달라"는 말이 없으면 채팅 답이다.',
  '노트가 비어 있어도 자동으로 쓰지 않는다. 쓰라는 요청이 있을 때만 쓴다.',
  '"이거 노트로 작성해 줘"처럼 이전 대화의 내용을 가리키면, 이전 대화에서 답한 내용을 노트 형식에 맞춰 블록으로 쓴다.',
  'note 블록 형식:',
  '- 커서 위치에 넣을 본문: 첫 줄 ```note-insert, 마지막 줄 ```',
  '- 섹션 하나를 바꿀 본문: 첫 줄 ```note-replace section="<heading 텍스트>", 마지막 줄 ```. heading 텍스트는 아래 "섹션 목록"에 적힌 그대로 쓴다(# 표시는 빼고). 블록 안은 그 heading 줄부터 섹션 끝까지 전체를 쓴다.',
  '- 문서 전체를 바꿀 본문: 첫 줄 ```note-replace-all, 마지막 줄 ```. 블록 안은 문서 전체다.',
  '- 블록 안 코드 블록은 반드시 언어를 쓴다(```java). 언어 없는 ``` 줄은 블록을 닫는 줄로만 쓴다.',
  '- note 블록과 함께 쓰는 채팅 설명은 무엇을 했는지 1~2줄만 쓴다. 블록 뒤에는 덧붙이지 않는다. 노트 본문을 블록 밖 채팅에 다시 쓰지 않는다.',
  '대화 문장은 존댓말("~합니다", "~입니다")로 짧고 담백하게 쓴다. 다만 채팅으로 답하는 커리큘럼, 설명, 표는 줄이거나 생략하지 않고 전부 쓴다.',
];

/** A conversation turn about the open note. */
export function buildNoteChatPrompt(input: NoteChatPromptInput): string {
  const parts: string[] = [];
  parts.push(`## 작업 (${TASK_CHAT})`, '사용자와 지금 열린 노트에 대해 대화한다. 기본은 채팅 답이고, 노트에 쓰거나 고치라고 명시한 요청에만 본문을 note 블록으로 낸다.', '');
  parts.push('## 답변 형식', ...NOTE_REPLY_RULES, '');
  parts.push('## 노트 경로', input.notePath, '');
  pushStyleRefs(parts, input.styleRefs);
  const doc = input.document.trim() ? clipDocument(input.document) : '(빈 문서)';
  parts.push('## 섹션 목록', outline(input.document), '');
  parts.push('## 현재 노트', '<document>', doc, '</document>', '');
  const history = input.history.slice(-HISTORY_MAX_ITEMS);
  if (history.length > 0) {
    parts.push('## 이전 대화');
    for (const row of history) {
      const text = row.text.length > HISTORY_ITEM_MAX_CHARS ? `${row.text.slice(0, HISTORY_ITEM_MAX_CHARS)} …` : row.text;
      parts.push(`<${row.role}>`, text, `</${row.role}>`);
    }
    parts.push('');
  }
  parts.push('## 요청', input.request.slice(0, REQUEST_MAX_CHARS).trim());
  return parts.join('\n');
}

/** The floating prompt: rewrite the selection (or write at the caret); the answer is the new text only. */
export function buildNoteInlinePrompt(input: NoteInlinePromptInput): string {
  const doc = input.document;
  const from = Math.max(0, Math.min(input.selection.from, doc.length));
  const to = Math.max(from, Math.min(input.selection.to, doc.length));
  const write = from === to;
  const parts: string[] = [];
  if (write) {
    parts.push(`## 작업 (${TASK_INLINE_WRITE})`, '요청한 내용을 노트의 커서 위치에 들어갈 마크다운으로 쓴다. 앞뒤 흐름과 heading 수준에 맞춘다.', '');
  } else {
    parts.push(`## 작업 (${TASK_INLINE_EDIT})`, '아래 "선택 범위"만 요청대로 고쳐 쓴다. 출력은 선택 범위를 그대로 대체한다. 범위 밖의 내용은 출력하지 않고, 범위가 문장 일부면 문장 일부로 답한다.', '');
  }
  parts.push('## 출력', '- 대체할(또는 넣을) 마크다운 본문만 출력한다.', '- 출력 전체를 코드펜스(```)로 감싸지 않는다.', '- 앞뒤에 설명이나 확인 문장을 붙이지 않는다.', '');
  parts.push('## 요청', input.request.slice(0, REQUEST_MAX_CHARS).trim(), '');
  parts.push('## 노트 경로', input.notePath, '');
  pushStyleRefs(parts, input.styleRefs);
  parts.push('## 섹션 목록', outline(doc), '');
  const before = doc.slice(Math.max(0, from - CONTEXT_BEFORE_CHARS), from);
  const after = doc.slice(to, to + CONTEXT_AFTER_CHARS);
  parts.push('## 앞 내용', '<before>', before || '(문서 처음)', '</before>', '');
  if (!write) {
    const sel = doc.slice(from, to);
    parts.push('## 선택 범위', '<selection>', clipDocument(sel, SELECTION_MAX_CHARS), '</selection>', '');
  } else {
    parts.push('## 커서 위치', '(앞 내용과 뒤 내용 사이)', '');
  }
  parts.push('## 뒤 내용', '<after>', after || '(문서 끝)', '</after>');
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
