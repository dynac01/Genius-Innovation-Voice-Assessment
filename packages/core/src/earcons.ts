/**
 * Earcon specifications.
 *
 * The brief is specific: short, distinct, non-fatiguing sounds that signal state
 * without words — a faint tone on listening, a soft blip on accept, a gentle chime
 * on ready, a descending tone on failure. Each under half a second, and injected
 * into the output without clobbering speech.
 *
 * The *shape* of each sound is data and lives here, where it can be asserted
 * against those requirements. Only the oscillator wiring lives in the browser, and
 * it carries no decisions. That split is why "every earcon is under 500ms" is a
 * test rather than a hope.
 *
 * On not clobbering speech: these never pass through the speech gain node. They are
 * mixed in parallel, which makes interference structurally impossible rather than
 * merely unlikely — a barge-in ramp cannot mute a `failed` tone, and a `ready` chime
 * cannot duck the reply behind it.
 *
 * On not being fatiguing: pure sines at low amplitude, with an attack and release on
 * every tone. A hard start or stop at a non-zero sample is a click, and a click
 * heard forty times an hour is exactly the fatigue the brief warns about.
 */

import type { EarconSound } from './protocol.js';

export interface EarconTone {
  /** Offset from the start of the earcon. */
  readonly startMs: number;
  readonly durationMs: number;
  /** Start and end of a linear glide. Equal values mean a steady tone. */
  readonly fromHz: number;
  readonly toHz: number;
  /** Peak gain, 0–1. Deliberately low; these sit under speech, not over it. */
  readonly peak: number;
  readonly attackMs: number;
  readonly releaseMs: number;
}

export interface EarconSpec {
  readonly sound: EarconSound;
  readonly tones: readonly EarconTone[];
}

/** The brief's ceiling: "Each under half a second". */
export const EARCON_MAX_MS = 500;

const tone = (t: Partial<EarconTone> & Pick<EarconTone, 'durationMs' | 'fromHz'>): EarconTone => ({
  startMs: 0,
  toHz: t.fromHz,
  peak: 0.07,
  attackMs: 6,
  releaseMs: 40,
  ...t,
});

export const EARCONS: Record<EarconSound, EarconSpec> = {
  /** Capture has started. Faint and low — heard once per session, not per turn. */
  listening: {
    sound: 'listening',
    tones: [tone({ fromHz: 620, durationMs: 140, peak: 0.05, releaseMs: 60 })],
  },

  /** The request was accepted. Short and bright, so it reads as acknowledgement. */
  accepted: {
    sound: 'accepted',
    tones: [tone({ fromHz: 880, durationMs: 90, peak: 0.06, releaseMs: 30 })],
  },

  /**
   * Something is ready. Two overlapping partials a fifth apart — the overlap is what
   * makes it read as a chime rather than as two beeps.
   */
  ready: {
    sound: 'ready',
    tones: [
      tone({ fromHz: 880, durationMs: 170, peak: 0.055, releaseMs: 80 }),
      tone({ startMs: 90, fromHz: 1320, durationMs: 220, peak: 0.045, releaseMs: 120 }),
    ],
  },

  /** Something failed. Descending, because falling pitch reads as negative. */
  failed: {
    sound: 'failed',
    tones: [tone({ fromHz: 520, toHz: 260, durationMs: 300, peak: 0.08, releaseMs: 90 })],
  },
};

/** Total wall time of an earcon, including any overlap between its tones. */
export function earconDurationMs(spec: EarconSpec): number {
  let end = 0;
  for (const t of spec.tones) end = Math.max(end, t.startMs + t.durationMs);
  return end;
}

/** Loudest point of an earcon. Used to keep the set balanced against each other. */
export function earconPeak(spec: EarconSpec): number {
  let peak = 0;
  for (const t of spec.tones) peak = Math.max(peak, t.peak);
  return peak;
}

export const EARCON_SOUNDS = Object.keys(EARCONS) as EarconSound[];
