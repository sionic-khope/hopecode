// Decides which characters of a streaming assistant reply get a voice blip (pure: no audio, no DOM, unit-tested).
// The rules keep the voice a texture, not a typewriter: one blip per 2-3 letters, at most one per ~60ms, rests on
// spaces / punctuation / line breaks, silence inside fenced and inline code, and a long reply fades out (each new
// paragraph gets a short burst back).

/** Shortest gap between two blips (ms). */
export const VOICE_MIN_GAP_MS = 62;
/** Rest after sentence punctuation / a line break (ms). */
export const VOICE_REST_PUNCT_MS = 140;
export const VOICE_REST_NEWLINE_MS = 180;
/** Letter weight that makes one blip (a Hangul / CJK syllable weighs 1.5, so 2 syllables or 3 Latin letters). */
export const VOICE_STRIDE = 3;
/** Voiced letters after which the blips thin out, and where they stop. */
export const VOICE_FADE_START = 480;
export const VOICE_FADE_END = 900;
/** Blips a new paragraph gets back once the reply has faded. */
export const VOICE_PARAGRAPH_BURST = 3;

export interface VoiceState {
  /** Inside a ``` fence. */
  fence: boolean;
  /** Inside `inline code`. */
  inline: boolean;
  /** Text of the current line so far (fence detection survives chunk boundaries). */
  line: string;
  /** The current line opens / closes a fence: nothing on it is voiced. */
  fenceLine: boolean;
  /** Voiced letters of this reply so far. */
  voiced: number;
  /** Letter weight gathered since the last blip. */
  weight: number;
  /** Time of the last blip, and no blip before `restUntil`. */
  lastAt: number;
  restUntil: number;
  /** Line breaks in a row (2 = a new paragraph). */
  newlines: number;
  /** Full-rate blips left after a paragraph break in a faded reply. */
  burst: number;
  /** Characters seen (position of the next character in the reply). */
  pos: number;
}

export function createVoiceState(): VoiceState {
  return {
    fence: false,
    inline: false,
    line: '',
    fenceLine: false,
    voiced: 0,
    weight: 0,
    lastAt: -Infinity,
    restUntil: -Infinity,
    newlines: 0,
    burst: 0,
    pos: 0,
  };
}

const LETTER_RE = /[\p{L}\p{N}]/u;
const WIDE_RE = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const SENTENCE_END_RE = /[.!?…。！？,;:、，]/;

/** Weight a blip needs at `voiced` letters into the reply; Infinity once the reply has faded out. */
export function strideAt(voiced: number): number {
  if (voiced <= VOICE_FADE_START) return VOICE_STRIDE;
  if (voiced >= VOICE_FADE_END) return Infinity;
  // Linear thinning: 1x at the fade start, 4x just before the end.
  return VOICE_STRIDE * (1 + (3 * (voiced - VOICE_FADE_START)) / (VOICE_FADE_END - VOICE_FADE_START));
}

/**
 * Feeds one text chunk that arrived at `now` (ms). Returns the next state and the reply positions (character index)
 * that blip. A chunk arrives at one instant, so it blips at most once (the minimum gap applies within it too).
 */
export function feedVoice(prev: VoiceState, text: string, now: number): { state: VoiceState; blips: number[] } {
  const s: VoiceState = { ...prev };
  const blips: number[] = [];
  for (const ch of text) {
    const pos = s.pos;
    s.pos += ch.length;
    if (ch === '\n') {
      if (s.fenceLine) s.fence = !s.fence;
      s.line = '';
      s.fenceLine = false;
      s.inline = false;
      s.newlines++;
      s.restUntil = Math.max(s.restUntil, now + VOICE_REST_NEWLINE_MS);
      if (s.newlines === 2 && s.voiced > VOICE_FADE_START && !s.fence) s.burst = VOICE_PARAGRAPH_BURST;
      continue;
    }
    if (ch !== '\r' && ch !== ' ' && ch !== '\t') s.newlines = 0;
    s.line += ch;
    if (!s.fenceLine && s.line.length <= 16 && s.line.trimStart().startsWith('```')) {
      s.fenceLine = true;
      s.inline = false;
    }
    if (s.fence || s.fenceLine) continue;
    if (ch === '`') {
      s.inline = !s.inline;
      continue;
    }
    if (s.inline) continue;
    if (!LETTER_RE.test(ch)) {
      if (SENTENCE_END_RE.test(ch)) s.restUntil = Math.max(s.restUntil, now + VOICE_REST_PUNCT_MS);
      continue;
    }
    s.voiced++;
    s.weight += WIDE_RE.test(ch) ? 1.5 : 1;
    const stride = s.burst > 0 ? VOICE_STRIDE : strideAt(s.voiced);
    if (s.weight < stride) continue;
    // A rest or the minimum gap holds the blip back; the weight stays (capped) so the next free letter speaks.
    if (now < s.restUntil || now - s.lastAt < VOICE_MIN_GAP_MS) {
      s.weight = Math.min(s.weight, stride);
      continue;
    }
    blips.push(pos);
    s.weight = 0;
    s.lastAt = now;
    if (s.burst > 0) s.burst--;
  }
  return { state: s, blips };
}
