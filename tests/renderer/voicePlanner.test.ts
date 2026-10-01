import { describe, expect, it } from 'vitest';
import {
  VOICE_FADE_END,
  VOICE_FADE_START,
  VOICE_CHAR_MS,
  VOICE_MIN_GAP_MS,
  createVoiceState,
  feedVoice,
  strideAt,
  type VoiceState,
} from '../../src/renderer/sound/voicePlanner';

/** Streams `text` one character at a time, `gap` ms apart; returns the blip positions. */
function stream(text: string, gap = 100, start: VoiceState = createVoiceState(), t0 = 1000): { blips: number[]; state: VoiceState } {
  let state = start;
  const blips: number[] = [];
  let now = t0;
  for (const ch of text) {
    const r = feedVoice(state, ch, now);
    state = r.state;
    blips.push(...r.blips);
    now += gap;
  }
  return { blips, state };
}

describe('voice planner', () => {
  it('blips about once per 2-3 letters, never on every letter', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(4);
    const { blips } = stream(text);
    expect(blips.length).toBeGreaterThan(text.length / 4);
    expect(blips.length).toBeLessThanOrEqual(Math.ceil(text.length / 3));
    const hangul = '안녕하세요반갑습니다오늘도좋은하루되세요';
    const h = stream(hangul).blips;
    expect(h.length).toBeLessThanOrEqual(Math.ceil(hangul.length / 2));
    expect(h.length).toBeGreaterThanOrEqual(Math.floor(hangul.length / 3));
  });

  it('keeps a minimum gap on the typing clock; a chunk delivered at once is spread, not one blip or a pile', () => {
    const minChars = Math.ceil(VOICE_MIN_GAP_MS / VOICE_CHAR_MS);
    const fast = stream('abcdefghijklmnopqrstuvwxyz'.repeat(4), 10).blips;
    for (let i = 1; i < fast.length; i++) expect(fast[i]! - fast[i - 1]!).toBeGreaterThanOrEqual(minChars);
    const text = 'a long chunk of plain words arriving at once';
    const chunk = feedVoice(createVoiceState(), text, 0);
    expect(chunk.blips.length).toBeGreaterThan(1);
    expect(chunk.blips.length).toBeLessThanOrEqual(Math.ceil(text.length / minChars));
    // The clock ran ahead by the typed length, so a chunk right behind it continues the cadence.
    expect(chunk.state.clock).toBe(text.length * VOICE_CHAR_MS);
  });

  it('never blips on spaces, punctuation or line breaks, and rests after them', () => {
    const text = 'Hello, world. How are you?\nFine thanks!';
    const { blips } = stream(text);
    for (const pos of blips) expect(text[pos]).toMatch(/[A-Za-z]/);
    // Right after the period the next letters are held back by the rest.
    const s0 = feedVoice(createVoiceState(), 'abc.', 0).state;
    expect(feedVoice({ ...s0, weight: 3 }, 'd', 50).blips).toEqual([]);
  });

  it('is silent inside fenced code blocks and inline code, across chunk boundaries', () => {
    const text = 'Here is it:\n\n```ts\nexport function greet(name: string) {\n  return name;\n}\n```\n\nUse `greetEveryone` now please.';
    const fenceStart = text.indexOf('```');
    const fenceEnd = text.lastIndexOf('```') + 3;
    const inlineStart = text.indexOf('`greet');
    const inlineEnd = text.indexOf('`', inlineStart + 1);
    for (const gap of [100, 30]) {
      const { blips } = stream(text, gap);
      expect(blips.length).toBeGreaterThan(0);
      for (const pos of blips) {
        expect(pos >= fenceStart && pos < fenceEnd, `pos ${pos} in fence`).toBe(false);
        expect(pos >= inlineStart && pos <= inlineEnd, `pos ${pos} in inline code`).toBe(false);
      }
      // Text after the closing fence speaks again.
      expect(blips.some((p) => p > fenceEnd)).toBe(true);
    }
    // Same text in 3 uneven chunks (a fence split mid-backticks).
    let state = createVoiceState();
    const out: number[] = [];
    let now = 0;
    for (const part of [text.slice(0, fenceStart + 1), text.slice(fenceStart + 1, fenceStart + 9), text.slice(fenceStart + 9)]) {
      for (const ch of part) {
        const r = feedVoice(state, ch, (now += 100));
        state = r.state;
        out.push(...r.blips);
      }
    }
    for (const pos of out) expect(pos >= fenceStart && pos < fenceEnd).toBe(false);
  });

  it('thins out over a long reply, stops, and gives a new paragraph a short burst', () => {
    expect(strideAt(10)).toBe(strideAt(VOICE_FADE_START));
    expect(strideAt(VOICE_FADE_START + 200)).toBeGreaterThan(strideAt(VOICE_FADE_START));
    expect(strideAt(VOICE_FADE_END)).toBe(Infinity);

    const word = 'lorem ipsum dolor sit amet ';
    const long = word.repeat(60); // ~1300 letters
    const { blips, state } = stream(long);
    const posOfLetter = (n: number) => {
      let seen = 0;
      for (let i = 0; i < long.length; i++) if (/[a-z]/.test(long[i]!) && ++seen === n) return i;
      return long.length;
    };
    const early = blips.filter((p) => p < posOfLetter(VOICE_FADE_START)).length;
    const fading = blips.filter((p) => p >= posOfLetter(VOICE_FADE_START) && p < posOfLetter(VOICE_FADE_END)).length;
    const after = blips.filter((p) => p >= posOfLetter(VOICE_FADE_END)).length;
    expect(fading).toBeLessThan(early);
    expect(after).toBe(0);

    // A blank line starts a paragraph: a few blips come back, then silence again.
    const next = stream('\n\nAnother paragraph begins here with more words to say', 100, state, 1000 + long.length * 100 + 1000);
    expect(next.blips.length).toBeGreaterThan(0);
    expect(next.blips.length).toBeLessThanOrEqual(3);
  });
});
