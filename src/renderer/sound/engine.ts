// UI sounds in the spirit of an RPG text box: per-agent voice blips and short square-wave cues (move, select, back,
// send, done, error), synthesized with WebAudio -- no audio files ship with the app. A file in a theme sound slot
// (~/.hopecode/theme/sounds/<slot>.{wav,ogg,mp3}) replaces the synthesized sound of that slot.
//
// Every request is gated on 설정 > 사운드. In fixture / e2e runs (bootstrap `testMode`) no AudioContext is ever
// created: requests are only recorded in `window.__hcSoundLog`, which is the seam the e2e specs assert on.
import type { AgentKind } from '../../shared/types';
import type { ThemeSoundSlot } from '../../shared/theme';
import { useAppStore } from '../store';
import { getThemeOverlay } from '../theme/themeOverlay';

export type SfxKind = 'move' | 'select' | 'back' | 'send' | 'done' | 'error';

export interface SoundLogEntry {
  kind: SfxKind | 'voice';
  agent?: AgentKind;
  threadId?: string;
  itemId?: string;
  /** Voice: character index in the reply that blipped. */
  pos?: number;
  at: number;
}

declare global {
  interface Window {
    /** Test runs only: every sound the app asked for (newest last, capped). */
    __hcSoundLog?: SoundLogEntry[];
    /** Test runs only: stand-in for window focus (the hidden e2e window never has focus). Default true. */
    __hcSoundFocused?: boolean;
  }
}

/** Overall loudness (0..1); the cues stay well under the conversation's attention. */
export const MASTER_VOLUME = 0.25;
/** The same cue twice within this window (one click seen by several handlers, StrictMode) plays once. */
const DEBOUNCE_MS = 30;
const LOG_CAP = 500;

const lastAt = new Map<string, number>();
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();

function testMode(): boolean {
  return useAppStore.getState().testMode;
}

/** Sounds may play: settings loaded (bootstrap) and 사운드 on. */
export function soundEnabled(): boolean {
  const s = useAppStore.getState();
  return s.bootstrapped && s.settings.soundEnabled;
}

/** The window has focus (voice and done only play then). */
export function windowFocused(): boolean {
  if (testMode()) return window.__hcSoundFocused ?? true;
  return document.hasFocus() && !document.hidden;
}

function record(entry: Omit<SoundLogEntry, 'at'>): void {
  const log = (window.__hcSoundLog ??= []);
  log.push({ ...entry, at: Date.now() });
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
}

function audio(): { ctx: AudioContext; out: GainNode } | null {
  if (testMode()) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = MASTER_VOLUME;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return { ctx, out: master! };
  } catch {
    return null;
  }
}

/** Turning sound off cuts whatever is still ringing; turning it back on restores the volume. */
export function applySoundEnabled(on: boolean): void {
  if (!ctx || !master) return;
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setValueAtTime(on ? MASTER_VOLUME : 0, ctx.currentTime);
}

function slotBuffer(a: AudioContext, slot: ThemeSoundSlot): Promise<AudioBuffer | null> | null {
  const url = getThemeOverlay().sounds[slot];
  if (!url) return null;
  let hit = buffers.get(url);
  if (!hit) {
    hit = fetch(url)
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => a.decodeAudioData(data))
      .catch((err: unknown) => {
        console.warn(`[sound] ${slot} overlay unusable, using the built-in sound`, err);
        return null;
      });
    buffers.set(url, hit);
  }
  return hit;
}

/** Plays the slot's file when the theme folder has one; otherwise `synth`. `onSource` gets the file's source node. */
function playSlot(
  slots: ThemeSoundSlot[],
  synth: (a: AudioContext, out: GainNode) => void,
  rate = 1,
  onSource?: (src: AudioBufferSourceNode) => void,
): void {
  const io = audio();
  if (!io) return;
  const pending = slots.map((slot) => slotBuffer(io.ctx, slot)).find((p) => p !== null);
  if (!pending) {
    synth(io.ctx, io.out);
    return;
  }
  void pending.then((buffer) => {
    if (!buffer) {
      synth(io.ctx, io.out);
      return;
    }
    const src = io.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(io.out);
    src.start();
    onSource?.(src);
  });
}

/** The voice file still ringing: the next blip cuts it, like the game's text writer (stop, then play). */
let voiceSrc: AudioBufferSourceNode | null = null;

function takeVoice(src: AudioBufferSourceNode): void {
  stopVoice();
  voiceSrc = src;
  src.onended = () => {
    if (voiceSrc === src) voiceSrc = null;
  };
}

/** Silences the current voice blip (the reply finished, or the user switched away). */
export function stopVoice(): void {
  const src = voiceSrc;
  voiceSrc = null;
  if (!src) return;
  try {
    src.stop();
  } catch {
    // Already stopped.
  }
}

type Wave = OscillatorType | 'pulse';

let pulseWave: PeriodicWave | null = null;
/** 25% duty pulse: the thinner, nasal square of old sound chips. */
function pulse(a: AudioContext): PeriodicWave {
  if (pulseWave) return pulseWave;
  const n = 32;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25);
    imag[k] = 0;
  }
  pulseWave = a.createPeriodicWave(real, imag);
  return pulseWave;
}

/** One enveloped tone: `notes` are [frequency Hz, duration s] played back to back. */
function tone(a: AudioContext, out: GainNode, wave: Wave, notes: [number, number][], level: number, delay = 0): void {
  let t = a.currentTime + 0.005 + delay;
  for (const [freq, dur] of notes) {
    const osc = a.createOscillator();
    if (wave === 'pulse') osc.setPeriodicWave(pulse(a));
    else osc.type = wave;
    osc.frequency.setValueAtTime(freq, t);
    const env = a.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.003);
    env.gain.setValueAtTime(level, t + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env);
    env.connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.01);
    t += dur;
  }
}

const SFX: Record<SfxKind, (a: AudioContext, out: GainNode) => void> = {
  move: (a, o) => tone(a, o, 'square', [[880, 0.028]], 0.22),
  select: (a, o) => tone(a, o, 'square', [[988, 0.035], [1319, 0.05]], 0.22),
  // Cancel: the select figure turned downwards, lower.
  back: (a, o) => tone(a, o, 'square', [[587, 0.035], [440, 0.06]], 0.22),
  send: (a, o) => tone(a, o, 'pulse', [[523, 0.04], [784, 0.04], [1047, 0.07]], 0.24),
  done: (a, o) => tone(a, o, 'triangle', [[784, 0.09], [1175, 0.16]], 0.3),
  error: (a, o) => tone(a, o, 'sawtooth', [[196, 0.09], [147, 0.18]], 0.16),
};

/** Voice per agent: waveform and base pitch. */
const VOICES: Record<AgentKind, { wave: Wave; base: number; slot: ThemeSoundSlot }> = {
  'claude-code': { wave: 'square', base: 494, slot: 'voice-claude' },
  codex: { wave: 'pulse', base: 392, slot: 'voice-codex' },
  hermes: { wave: 'triangle', base: 659, slot: 'voice-hermes' },
};

function debounced(key: string): boolean {
  const now = performance.now();
  const prev = lastAt.get(key);
  if (prev !== undefined && now - prev < DEBOUNCE_MS) return true;
  lastAt.set(key, now);
  return false;
}

/** A UI cue. `select` is dropped while a `back` of the same gesture just played. */
export function playSfx(kind: SfxKind): void {
  if (!soundEnabled()) return;
  if (debounced(kind)) return;
  if (kind === 'select' && lastAt.has('back') && performance.now() - lastAt.get('back')! < DEBOUNCE_MS) return;
  if (testMode()) {
    record({ kind });
    return;
  }
  playSlot([kind], SFX[kind]);
}

/** One voice blip of `agent`: a theme voice file plays as is (like the game narrator); the synth blip is pitch-jittered. */
export function playVoice(agent: AgentKind, info: { threadId: string; itemId: string; pos: number }): void {
  if (!soundEnabled()) return;
  if (testMode()) {
    record({ kind: 'voice', agent, ...info });
    return;
  }
  const voice = VOICES[agent];
  const jitter = 1 + (Math.random() - 0.5) * 0.12;
  playSlot([voice.slot, 'voice'], (a, o) => tone(a, o, voice.wave, [[voice.base * jitter, 0.04]], 0.18), 1, takeVoice);
}
