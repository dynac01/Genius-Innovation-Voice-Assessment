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
 * The bias here is the opposite of the endpointer's: a late stop is the failure
 * everyone hears, so release is slow and the detector leans toward firing.
 *
 * ## Leaning toward firing is not the same as firing at anything
 *
 * It was, and a session log settled the argument. Across one conversation the
 * detector reported five separate speech runs totalling ~4.3 seconds during which
 * Deepgram — a real speech model, on the same microphone, in the same room —
 * transcribed nothing whatsoever. Those were not quiet words it missed. They were
 * a room, and this detector called them speech.
 *
 * The cost was not a stray metric. Every one of those runs could abandon a reply,
 * and several did: replies destroyed before a sample was audible, transcripts
 * scrolling past, and an assistant that appeared to have simply stopped talking.
 *
 * The published stack for this is three layers, and this had one and a half:
 *
 *   1. **Energy gate** — an absolute floor, around -40 dBFS in reference designs.
 *   2. **Voice classifier** — Silero or a small CNN, confidence above ~0.7.
 *   3. **Minimum-duration guard** — 200-300ms of sustained voice, which is credited
 *      with removing 60-80% of false barge-ins on its own.
 *
 * Layers 1 and 3 are here now. Layer 2 is not: a neural classifier means shipping
 * an ONNX runtime and a model into the browser, and that is a change worth making
 * deliberately rather than while chasing a bug. It is the honest next step, and it
 * is named as one in the README rather than quietly skipped.
 *
 * What layer 1 fixes is subtle and was the actual defect. The threshold was
 * *purely* adaptive — N dB above a tracked noise floor — which sounds robust and
 * is the opposite in a quiet room: the floor tracks down toward silence, and a
 * fixed margin above near-silence is still near-silence. An absolute gate is what
 * stops a quiet room from redefining what counts as a voice.
 */

export interface VadConfig {
  /**
   * Sustained speech required before declaring onset — the minimum-duration guard.
   *
   * This was 50ms, chosen to keep the measured barge-in number small, and it is the
   * single reason a cough, a chair, or a breath could destroy a reply. Reference
   * pipelines use 250ms and credit the guard alone with removing 60-80% of false
   * barge-ins.
   *
   * It costs real latency and the trade is worth stating plainly: stopping moves
   * from ~74ms after voice onset to a measured 271ms, against the brief's ~300ms target. The
   * old number was only ever achievable because the detector fired on anything, so
   * it was not measuring what it appeared to measure.
   */
  readonly onsetMs: number;
  /** Quiet needed before declaring speech over. Long enough to span word gaps. */
  readonly releaseMs: number;
  /** dB above the noise floor that counts as speech. */
  readonly thresholdDb: number;
  /**
   * Absolute level below which nothing is speech, whatever the noise floor says.
   *
   * The backstop for the adaptive threshold. In a quiet room the tracked floor
   * falls toward silence and a fixed margin above it admits room tone as a voice;
   * a real speaker at a normal distance clears -40 dBFS comfortably. Both
   * conditions must hold, so the adaptive part can still *raise* the bar in a noisy
   * room without ever being able to lower it below this.
   */
  readonly absoluteGateDb: number;
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
  onsetMs: 250,
  releaseMs: 250,
  thresholdDb: 12,
  absoluteGateDb: -40,
  duckedThresholdDb: 24,
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
    /*
     * Both gates, not either. The adaptive one keeps the detector working in a
     * noisy room by raising the bar; the absolute one stops a quiet room from
     * lowering it, which is how room tone came to be treated as a voice.
     */
    const isSpeech = level > this.#floorDb + threshold && level > this.#config.absoluteGateDb;

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
