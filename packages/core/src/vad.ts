/**
 * Voice activity detection — the fast half of barge-in.
 *
 * The latency budget is what forces this into the browser. Detecting an
 * interruption from STT partials means 200–500ms of network and provider time
 * before a stop command could even start travelling back, and the brief asks for
 * under ~300ms end to end. So the browser decides *that* the user spoke and
 * silences output locally; the server round trip only decides what the
 * interruption **meant**. Two paths, and only the slow one is allowed to be slow.
 *
 * The bias here is the opposite of the endpointer's. A late stop is the failure
 * everyone hears, so onset is deliberately twitchy — 50ms — and release is slow, to
 * avoid chattering on the gaps between words.
 */

export interface VadConfig {
  /** Speech-ish audio needed before declaring onset. Short: a late stop is worse. */
  readonly onsetMs: number;
  /** Quiet needed before declaring speech over. Long enough to span word gaps. */
  readonly releaseMs: number;
  /** dB above the noise floor that counts as speech. */
  readonly thresholdDb: number;
  /**
   * dB above the floor required while the assistant is talking.
   *
   * Browser AEC removes most of the assistant's voice from the microphone, but not
   * all of it — and on a phone speaker, the residue is loud. Without a raised bar
   * here the assistant interrupts itself, which fails the criterion weighted
   * hardest in the most confusing way possible: it looks like the barge-in works
   * *too* well.
   */
  readonly duckedThresholdDb: number;
  /** Per-frame smoothing of the noise floor when the room gets quieter. */
  readonly floorFallPerFrameDb: number;
  /** Per-frame smoothing when it gets louder. Slower, so speech cannot raise it. */
  readonly floorRisePerFrameDb: number;
}

export const DEFAULT_VAD: VadConfig = {
  onsetMs: 50,
  releaseMs: 250,
  thresholdDb: 9,
  duckedThresholdDb: 16,
  floorFallPerFrameDb: 1.0,
  floorRisePerFrameDb: 0.08,
};

export type VadEvent = 'none' | 'speech_start' | 'speech_end';

/** Quietest level we bother representing; digital silence maps here. */
const FLOOR_DB = -100;
const INITIAL_FLOOR_DB = -55;

/** RMS level of a frame in dBFS. */
export function frameLevelDb(pcm: Int16Array): number {
  if (pcm.length === 0) return FLOOR_DB;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] ?? 0;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / pcm.length) / 32_768;
  if (rms <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(rms));
}

export class Vad {
  readonly #config: VadConfig;
  #floorDb = INITIAL_FLOOR_DB;
  #activeMs = 0;
  #quietMs = 0;
  #speaking = false;
  #outputActive = false;

  constructor(config: Partial<VadConfig> = {}) {
    this.#config = { ...DEFAULT_VAD, ...config };
    if (this.#config.duckedThresholdDb < this.#config.thresholdDb) {
      throw new RangeError('duckedThresholdDb must be at least thresholdDb');
    }
  }

  /** True between `speech_start` and `speech_end`. */
  get speaking(): boolean {
    return this.#speaking;
  }

  get noiseFloorDb(): number {
    return this.#floorDb;
  }

  /**
   * Tell the detector whether the assistant is currently audible.
   *
   * Raises the bar *and* freezes floor adaptation. Freezing matters as much as the
   * raised bar: letting echo drag the noise floor upward would leave the detector
   * numb for seconds after the assistant stops, exactly when the user is most
   * likely to speak.
   */
  setOutputActive(active: boolean): void {
    this.#outputActive = active;
  }

  process(pcm: Int16Array, frameMs: number): VadEvent {
    const level = frameLevelDb(pcm);
    const threshold = this.#outputActive
      ? this.#config.duckedThresholdDb
      : this.#config.thresholdDb;
    const isSpeech = level > this.#floorDb + threshold;

    if (!isSpeech && !this.#outputActive) this.#adaptFloor(level);

    if (isSpeech) {
      this.#activeMs += frameMs;
      this.#quietMs = 0;
    } else {
      this.#quietMs += frameMs;
      this.#activeMs = 0;
    }

    if (!this.#speaking && this.#activeMs >= this.#config.onsetMs) {
      this.#speaking = true;
      return 'speech_start';
    }
    if (this.#speaking && this.#quietMs >= this.#config.releaseMs) {
      this.#speaking = false;
      return 'speech_end';
    }
    return 'none';
  }

  reset(): void {
    this.#floorDb = INITIAL_FLOOR_DB;
    this.#activeMs = 0;
    this.#quietMs = 0;
    this.#speaking = false;
  }

  /**
   * Track the room, not the talker.
   *
   * Falls quickly so a detector started in a noisy moment settles fast; rises
   * slowly so a held vowel cannot lift the floor above itself and mute the speaker
   * mid-word.
   */
  #adaptFloor(level: number): void {
    this.#floorDb =
      level < this.#floorDb
        ? Math.max(FLOOR_DB, this.#floorDb - this.#config.floorFallPerFrameDb)
        : this.#floorDb + this.#config.floorRisePerFrameDb;
  }
}
