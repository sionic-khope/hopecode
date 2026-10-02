import { describe, expect, it } from 'vitest';
import { cardLines, cardStatus, cardTargetLabel, cardTitle, noteCards, parseNoteReply, replyProse } from '../../src/core/notes/noteReply';
import {
  cardTarget,
  findSection,
  fitSelection,
  locateApplied,
  normalizeHeading,
  planCard,
  revertCard,
  startStream,
  streamTo,
  type TextChange,
} from '../../src/core/notes/noteEdit';
import {
  CONTEXT_BEFORE_CHARS,
  HISTORY_ITEM_MAX_CHARS,
  HISTORY_MAX_ITEMS,
  NOTE_REPLY_RULES,
  STYLE_REF_MAX_FILES,
  buildNoteChatPrompt,
  buildNoteInlinePrompt,
  buildNoteSystemPrompt,
} from '../../src/core/notes/notePrompt';
import { noteFixtureAnswer, parseNotePrompt } from '../../src/main/fixtures/noteFixture';
import type { NoteCardMark } from '../../src/shared/notes';

const apply = (doc: string, c: TextChange) => doc.slice(0, c.from) + c.insert + doc.slice(c.to);

describe('parseNoteReply', () => {
  it('splits prose and the three card kinds, in order', () => {
    const text = [
      '초안을 만들었습니다.',
      '',
      '```note-insert',
      '# 분산 락',
      '',
      '본문입니다.',
      '```',
      '',
      '그리고 섹션 하나를 고쳤습니다.',
      '```note-replace section="2. 구조"',
      '### 2. 구조',
      '고친 구조입니다.',
      '```',
      '```note-replace-all',
      '# 새 문서',
      '```',
      '끝.',
    ].join('\n');
    const segs = parseNoteReply(text);
    expect(segs.map((s) => s.type)).toEqual(['text', 'card', 'text', 'card', 'card', 'text']);
    const cards = noteCards(text);
    expect(cards.map((c) => c.kind)).toEqual(['insert', 'replace', 'replace-all']);
    expect(cards[0]).toEqual({ kind: 'insert', section: null, body: '# 분산 락\n\n본문입니다.', complete: true });
    expect(cards[1].section).toBe('2. 구조');
    expect(cards[1].body).toBe('### 2. 구조\n고친 구조입니다.');
    expect(segs[0]).toEqual({ type: 'text', text: '초안을 만들었습니다.' });
    expect(segs.filter((s) => s.type === 'card').map((s) => (s.type === 'card' ? s.index : -1))).toEqual([0, 1, 2]);
  });

  it('keeps nested code blocks (with a language) inside a card', () => {
    const text = '```note-insert\n### 예시\n\n```java\nint a = 1;\n```\n\n뒤 문단입니다.\n```\n';
    const [card] = noteCards(text);
    expect(card.body).toBe('### 예시\n\n```java\nint a = 1;\n```\n\n뒤 문단입니다.');
    expect(card.complete).toBe(true);
    // A longer outer fence closes only on a fence at least as long.
    const four = '````note-insert\nA\n```\nB\n````';
    expect(noteCards(four)[0].body).toBe('A\n```\nB');
  });

  it('streaming: an open card is incomplete and fills in; a half-typed fence line is held back', () => {
    const full = '설명입니다.\n\n```note-insert\n# T\n\n본문 첫 줄\n본문 둘째 줄\n```\n';
    const partial = full.slice(0, full.indexOf('본문 둘째'));
    const segs = parseNoteReply(partial, true);
    expect(segs[0]).toEqual({ type: 'text', text: '설명입니다.' });
    expect(segs[1]).toMatchObject({ type: 'card', card: { kind: 'insert', complete: false, body: '# T\n\n본문 첫 줄' } });
    // `\`\`\`note-repl` mid-line: not shown as prose or a code block yet.
    expect(parseNoteReply('고쳤습니다.\n```note-repl', true)).toEqual([{ type: 'text', text: '고쳤습니다.' }]);
    // The closing fence half-arrived.
    expect(noteCards('```note-insert\nA\n``', true)[0]).toMatchObject({ body: 'A', complete: false });
    // The same answer once finished.
    expect(noteCards(full, false)[0].complete).toBe(true);
  });

  it('malformed blocks: no section, unknown kinds, a card never closed', () => {
    const [noSection] = noteCards('```note-replace\n### X\n```');
    expect(noSection).toMatchObject({ kind: 'replace', section: null });
    expect(cardTargetLabel(noSection)).toContain('대상 없음');
    // Unknown info strings are ordinary code blocks (prose).
    expect(parseNoteReply('```note-delete\nx\n```')).toEqual([{ type: 'text', text: '```note-delete\nx\n```' }]);
    expect(parseNoteReply('```js\nx\n```').every((s) => s.type === 'text')).toBe(true);
    // Single quotes and smart quotes name the section too.
    expect(noteCards("```note-replace section='정리'\nx\n```")[0].section).toBe('정리');
    expect(noteCards('```note-replace section=“정리”\nx\n```')[0].section).toBe('정리');
    // The answer ended without the closing fence: taken as complete.
    expect(noteCards('```note-insert\n# A\nbody')[0]).toMatchObject({ body: '# A\nbody', complete: true });
    // An empty card parses (applying it is refused).
    expect(noteCards('```note-insert\n```')[0].body).toBe('');
  });

  it('titles, target labels and prose summaries', () => {
    const [card] = noteCards('```note-insert\n본문만\n```');
    expect(cardTitle(card)).toBe('본문 초안');
    expect(cardTitle({ ...card, body: 'x\n## 2. 구조 ##\n' })).toBe('2. 구조');
    expect(cardTargetLabel({ kind: 'insert', section: null, body: '', complete: true })).toBe('커서 위치에 삽입');
    expect(cardTargetLabel({ kind: 'replace', section: '2. 구조', body: '', complete: true })).toBe("섹션 '2. 구조' 교체");
    expect(cardTargetLabel({ kind: 'replace-all', section: null, body: '', complete: true })).toBe('문서 전체 교체');
    expect(replyProse('앞.\n```note-insert\n# T\nb\n```\n뒤.')).toBe('앞.\n\n[note 블록: 커서 위치에 삽입 · T]\n\n뒤.');
    expect(cardLines(card)).toBe(1);
    expect(cardLines({ body: '' })).toBe(0);
  });

  it('an answer without note blocks is a chat reply: all of it is text (headings, tables, code included)', () => {
    const answer = '## RL 커리큘럼\n\n| 주차 | 주제 |\n| --- | --- |\n| 1 | MDP |\n\n```python\nenv.reset()\n```\n';
    expect(noteCards(answer)).toEqual([]);
    expect(parseNoteReply(answer)).toEqual([{ type: 'text', text: answer.trimEnd() }]);
    // Streaming: a chat answer is text from its first characters on.
    expect(parseNoteReply('## RL', true)).toEqual([{ type: 'text', text: '## RL' }]);
  });

  it('an answer with note blocks lists them in order for the editor (the sentence around them stays chat)', () => {
    const answer = ['작성했습니다.', '', '```note-insert', '# A', '```', '```note-replace section="2. 구조"', '### 2. 구조', '', 'x', '```'].join('\n');
    expect(noteCards(answer).map((c) => [c.kind, c.section, c.complete])).toEqual([
      ['insert', null, true],
      ['replace', '2. 구조', true],
    ]);
    expect(parseNoteReply(answer)[0]).toEqual({ type: 'text', text: '작성했습니다.' });
  });

  it('result status: a mark wins; no mark is "writing" while streaming, else an earlier unapplied card', () => {
    const applied: NoteCardMark = { state: 'applied', at: 0, inserted: 'x', original: '' };
    expect(cardStatus(applied, false)).toBe('applied');
    expect(cardStatus(applied, true)).toBe('applied');
    expect(cardStatus({ state: 'reverted' }, false)).toBe('reverted');
    expect(cardStatus({ state: 'skipped', reason: '없음' }, false)).toBe('skipped');
    expect(cardStatus(undefined, true)).toBe('writing');
    // Answers saved before blocks were written automatically: shown as not written, never as a button to insert.
    expect(cardStatus(undefined, false)).toBe('unapplied');
  });
});

const NOTE = ['# 분산 락', '', '개요다.', '', '### 1. 개념', '', '개념 본문.', '', '### 2. 구조', '', '구조 본문.', '', '```md', '### 2. 구조', '```', '', '### 정리', '', '- 끝'].join('\n');

describe('findSection', () => {
  it('matches heading text exactly, then without the leading number; ignores headings in code', () => {
    const exact = findSection(NOTE, '2. 구조');
    expect(exact.ok && NOTE.slice(exact.range.from, exact.range.to)).toBe('### 2. 구조\n\n구조 본문.\n\n```md\n### 2. 구조\n```\n\n');
    const loose = findSection(NOTE, '### 구조');
    expect(loose.ok && loose.range.title).toBe('2. 구조');
    const tail = findSection(NOTE, '정리');
    expect(tail.ok && NOTE.slice(tail.range.from)).toBe('### 정리\n\n- 끝');
    expect(normalizeHeading('## **Redis**  Lock')).toBe('redis lock');
    expect(findSection(NOTE, 'redis').ok).toBe(false);
  });

  it('fails on a missing, empty or ambiguous section', () => {
    expect(findSection(NOTE, '없는 섹션')).toEqual({ ok: false, error: "'없는 섹션' 섹션을 노트에서 찾을 수 없습니다" });
    expect(findSection(NOTE, '  ')).toMatchObject({ ok: false });
    const twice = '## 예시\na\n## 예시\nb\n';
    expect(findSection(twice, '예시')).toMatchObject({ ok: false, error: expect.stringContaining('2개') });
  });
});

describe('planCard / revertCard', () => {
  it('insert lands at the caret with blank lines around it', () => {
    const caret = NOTE.indexOf('### 2. 구조');
    const r = planCard(NOTE, { kind: 'insert', section: null, body: '### 1.5 사이\n\n새 내용.\n' }, caret);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = apply(NOTE, r.plan.change);
    expect(next).toContain('개념 본문.\n\n### 1.5 사이\n\n새 내용.\n\n### 2. 구조');
    expect(r.plan.original).toBe('');
  });

  it('replace swaps only the named section; replace-all and an empty note take everything', () => {
    const r = planCard(NOTE, { kind: 'replace', section: '2. 구조', body: '### 2. 구조\n\n새 구조다.' }, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = apply(NOTE, r.plan.change);
    expect(next).toContain('개념 본문.\n\n### 2. 구조\n\n새 구조다.\n\n### 정리');
    expect(next).not.toContain('구조 본문.');
    expect(next.startsWith('# 분산 락\n\n개요다.')).toBe(true);
    const all = planCard(NOTE, { kind: 'replace-all', section: null, body: '# 새 문서\n\n짧다.\n\n' }, 0);
    expect(all.ok && apply(NOTE, all.plan.change)).toBe('# 새 문서\n\n짧다.\n');
    const empty = planCard('', { kind: 'insert', section: null, body: '# A' }, 0);
    expect(empty.ok && apply('', empty.plan.change)).toBe('# A\n');
  });

  it('refuses a card whose section is missing, or with no body', () => {
    expect(planCard(NOTE, { kind: 'replace', section: '없음', body: 'x' }, 0)).toMatchObject({ ok: false });
    expect(planCard(NOTE, { kind: 'replace', section: null, body: 'x' }, 0)).toMatchObject({ ok: false });
    expect(planCard(NOTE, { kind: 'insert', section: null, body: ' \n' }, 0)).toEqual({ ok: false, error: '카드가 비어 있습니다' });
  });

  it('undo puts the replaced text back, also after the card moved; refuses once the text was edited', () => {
    const r = planCard(NOTE, { kind: 'replace', section: '1. 개념', body: '### 1. 개념\n\n바뀐 개념.' }, 0);
    if (!r.ok) throw new Error(r.error);
    const applied = { at: r.plan.change.from, inserted: r.plan.change.insert, original: r.plan.original };
    const after = apply(NOTE, r.plan.change);
    expect(apply(after, revertCard(after, applied)!)).toBe(NOTE);
    // Text typed above the card shifts it: found by its only occurrence.
    const shifted = `머리말\n${after}`;
    expect(apply(shifted, revertCard(shifted, applied)!)).toBe(`머리말\n${NOTE}`);
    // The card's text was edited: nothing to find.
    expect(revertCard(after.replace('바뀐 개념.', '손본 개념.'), applied)).toBeNull();
    expect(revertCard(after, { ...applied, inserted: '' })).toBeNull();
  });

  it('an inline answer keeps the selection’s own surrounding whitespace', () => {
    expect(fitSelection('  새 문장입니다.\n\n', ' 옛 문장입니다.\n')).toBe(' 새 문장입니다.\n');
    expect(fitSelection('구절', '구절이')).toBe('구절');
    expect(fitSelection('   ', 'x')).toBe('');
  });
});

describe('cardTarget / streamTo / locateApplied', () => {
  it('a block knows its place from its opening line: caret, named section, everything; an empty note takes it whole', () => {
    expect(cardTarget(NOTE, { kind: 'insert', section: null }, 5)).toEqual({ ok: true, range: { from: 5, to: 5 }, mode: 'insert' });
    const sec = cardTarget(NOTE, { kind: 'replace', section: '2. 구조' }, 0);
    expect(sec.ok && sec.mode).toBe('section');
    expect(sec.ok && NOTE.slice(sec.range.from, sec.range.to).startsWith('### 2. 구조\n')).toBe(true);
    expect(cardTarget(NOTE, { kind: 'replace-all', section: null }, 3)).toEqual({ ok: true, range: { from: 0, to: NOTE.length }, mode: 'all' });
    expect(cardTarget('  \n', { kind: 'insert', section: null }, 1)).toEqual({ ok: true, range: { from: 0, to: 3 }, mode: 'all' });
    expect(cardTarget(NOTE, { kind: 'replace', section: '없는 섹션' }, 0)).toEqual({ ok: false, error: "'없는 섹션' 섹션을 노트에서 찾을 수 없습니다" });
  });

  it('streamTo appends growing text, rewrites a re-read body, and puts the original back for an empty one', () => {
    const doc = 'aa OLD bb';
    let state = startStream({ from: 3, to: 6 }, doc);
    let shown = doc;
    const step = (full: string) => {
      const r = streamTo(state, full);
      if (r.change) shown = apply(shown, r.change);
      state = r.state;
      return r.change;
    };
    step('N');
    expect(shown).toBe('aa N bb');
    step('NEW');
    expect(shown).toBe('aa NEW bb');
    expect(step('NEW')).toBeNull();
    step('NOW');
    expect(shown).toBe('aa NOW bb');
    step('');
    expect(shown).toBe('aa OLD bb');
    step('X');
    expect(shown).toBe('aa X bb');
  });

  it('locateApplied finds written text where it landed, or at its only occurrence; null once edited', () => {
    const doc = '머리\n본문 A\n끝';
    const at = doc.indexOf('본문 A');
    expect(locateApplied(doc, { at, inserted: '본문 A' })).toEqual({ from: at, to: at + 4 });
    expect(locateApplied(`앞${doc}`, { at, inserted: '본문 A' })).toEqual({ from: at + 1, to: at + 5 });
    expect(locateApplied('본문 A 본문 A', { at: 99, inserted: '본문 A' })).toBeNull();
    expect(locateApplied(doc, { at, inserted: '' })).toBeNull();
  });
});

describe('note prompts', () => {
  const refs = Array.from({ length: 4 }, (_, i) => ({ path: `a/${i}.md`, excerpt: `ref ${i}` }));

  it('chat: reply rules, section list, the note, capped history and the request last', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), text: `turn ${i} ${'x'.repeat(i === 11 ? HISTORY_ITEM_MAX_CHARS + 500 : 1)}` }));
    const p = buildNoteChatPrompt({ request: '2번 섹션 예시 더', notePath: 'a/x.md', document: NOTE, history, styleRefs: refs });
    expect(p.startsWith('## 작업 (대화)')).toBe(true);
    for (const rule of NOTE_REPLY_RULES) expect(p).toContain(rule);
    expect(p).toContain('```note-replace section="<heading 텍스트>"');
    expect(p).toContain('## 섹션 목록\n- # 분산 락\n    - ### 1. 개념\n    - ### 2. 구조\n    - ### 정리\n');
    expect(p).toContain(`<document>\n${NOTE}\n</document>`);
    expect(p.match(/<reference /g)).toHaveLength(STYLE_REF_MAX_FILES);
    expect(p.match(/<user>|<assistant>/g)).toHaveLength(HISTORY_MAX_ITEMS);
    expect(p).not.toContain('turn 3 ');
    expect(p).toContain(`${'x'.repeat(HISTORY_ITEM_MAX_CHARS - 'turn 11 '.length)} …`);
    expect(p.endsWith('## 요청\n2번 섹션 예시 더')).toBe(true);
    expect(buildNoteChatPrompt({ request: 'r', notePath: 'x.md', document: '  ', history: [], styleRefs: [] })).toContain('(빈 문서)');
  });

  it('inline: the selection, its surroundings and the edit task; an empty range writes at the caret', () => {
    const from = NOTE.indexOf('구조 본문.');
    const edit = buildNoteInlinePrompt({ request: '더 짧게', notePath: 'a.md', document: NOTE, selection: { from, to: from + '구조 본문.'.length }, styleRefs: [] });
    expect(edit).toContain('## 작업 (선택 수정)');
    expect(edit).toContain('<selection>\n구조 본문.\n</selection>');
    expect(edit).toContain('### 2. 구조\n\n\n</before>');
    expect(edit).toContain('<after>\n\n\n```md');
    expect(edit).toContain('## 요청\n더 짧게');
    const write = buildNoteInlinePrompt({ request: '예시', notePath: 'a.md', document: NOTE, selection: { from: 0, to: 0 }, styleRefs: [] });
    expect(write).toContain('## 작업 (커서 위치 작성)');
    expect(write).toContain('<before>\n(문서 처음)\n</before>');
    expect(write).not.toContain('<selection>');
    // Long notes send only the text near the selection.
    const long = 'a'.repeat(50_000) + 'SEL' + 'b'.repeat(50_000);
    const clipped = buildNoteInlinePrompt({ request: 'r', notePath: 'a.md', document: long, selection: { from: 50_000, to: 50_003 }, styleRefs: [] });
    expect(clipped.length).toBeLessThan(CONTEXT_BEFORE_CHARS + 10_000);
  });

  it('reply rules: chat by default, note blocks only when asked to write or change the note', () => {
    const rules = NOTE_REPLY_RULES.join('\n');
    expect(rules).toContain('기본은 채팅 답이다');
    expect(rules).toContain('사용자가 노트에 쓰거나 고치라고 명시했을 때만 note 블록을 쓴다');
    expect(rules).toContain('커리큘럼이나 목차 요청도 "노트에 넣어 달라", "작성해 달라"는 말이 없으면 채팅 답이다.');
    expect(rules).toContain('노트가 비어 있어도 자동으로 쓰지 않는다.');
    expect(rules).toContain('note 블록과 함께 쓰는 채팅 설명은 무엇을 했는지 1~2줄만 쓴다.');
    expect(rules).toContain('```note-replace section="<heading 텍스트>"');
    expect(rules).toContain('```note-replace-all');
    expect(rules).not.toContain('카드');
    // A whole chat answer (a curriculum) fits in the history, so "이거 노트로 작성해 줘" can point back to it.
    expect(HISTORY_ITEM_MAX_CHARS).toBeGreaterThanOrEqual(4_000);
  });

  it('the system prompt keeps the note rules and forbids tools', () => {
    const sys = buildNoteSystemPrompt();
    expect(sys).toContain('도구를 쓰지 않는다');
    expect(sys).toContain('"~합니다"');
    expect(sys).toContain('대화 문장도 존댓말');
  });

  it('fixture answers: inline edit, insert / replace / replace-all cards and a plain answer', () => {
    const inline = buildNoteInlinePrompt({ request: '짧게', notePath: 'a.md', document: 'abc', selection: { from: 0, to: 3 }, styleRefs: [] });
    expect(parseNotePrompt(inline).kind).toBe('inline-edit');
    expect(noteFixtureAnswer(inline)).toBe('FIXTURE-INLINE: 짧게 요청대로 고친 문장입니다.');
    const chat = (request: string) => noteFixtureAnswer(buildNoteChatPrompt({ request, notePath: 'a.md', document: NOTE, history: [], styleRefs: [] }));
    // No ask to write: a chat answer with a heading and a table, no block.
    const plain = chat('RL 6개 커리큘럼 짜 주세요');
    expect(noteCards(plain)).toHaveLength(0);
    expect(plain).toContain('## RL 6개 커리큘럼 짜 주세요');
    expect(plain).toContain('| 주차 | 주제 | 목표 |');
    expect(noteCards(chat('Redis 분산 락 노트로 작성해 줘'))[0]).toMatchObject({ kind: 'insert', complete: true });
    expect(noteCards(chat('2번 섹션 예시 더 넣어 줘'))[0]).toMatchObject({ kind: 'replace', section: '2. 구조' });
    expect(noteCards(chat('2번 섹션 예시 더 넣어 줘'))[0].body).toContain('```java\nint example = 1;\n```');
    // "이거 노트로 작성해 줘" writes the last chat answer of the conversation.
    const back = noteFixtureAnswer(
      buildNoteChatPrompt({ request: '이거 노트로 작성해 줘', notePath: 'a.md', document: '', history: [{ role: 'user', text: 'RL 커리큘럼' }, { role: 'assistant', text: plain }], styleRefs: [] }),
    );
    expect(noteCards(back)[0].body).toContain('| 6 | Actor-Critic과 PPO | 안정적인 policy 학습 |');
    expect(noteCards(chat('전체를 짧게'))[0].kind).toBe('replace-all');
    expect(noteCards(chat('[chat] 왜 필요해'))).toHaveLength(0);
    const missing = noteCards(chat("'없는 섹션' 섹션 고쳐"))[0];
    expect(planCard(NOTE, missing, 0).ok).toBe(false);
  });
});
