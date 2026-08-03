/**
 * End-of-turn detection.
 *
 * This and barge-in are opposite-biased detectors reading the same microphone.
 * Barge-in wants ~50ms of speech onset and is biased toward firing — a late stop is
 * the failure everyone hears. Endpointing wants most of a second of trailing
 * silence and is biased *against* firing, because cutting someone off mid-thought
 * is worse than a beat of delay. They cannot share tuning, so they do not share code.
 *
 * The brief tests exactly the failure mode this guards: a partial, a short gap, then
 * more speech — the assistant must wait. That is why `pauseMs` reports a pause
 * without ending the turn: the dialog learns the user hesitated, and nothing else
 * happens.
 */

export interface EndpointerConfig {
  /**
   * Trailing silence that ends a turn.
   *
   * 700ms sits above conversational hesitation (typically 200–500ms) and below the
   * point where a reply feels sluggish. Stated in the README as the endpointing
   * window and measured against it.
   */
  readonly endOfTurnMs: number;
  /** Shorter silence, reported as `pause_detected` without ending the turn. */
  readonly pauseMs: number;
  /**
   * Trust an STT `final` as an endpoint on its own.
   *
   * Providers with their own endpointing (Deepgram's `speech_final`) are usually
   * better informed than a silence timer, having acoustic features we never see.
   * Turn it off for a provider whose finals mean "this text is stable" rather than
   * "the speaker stopped" — the two are not the same claim.
   */
  readonly trustSttFinal: boolean;
}

export const DEFAULT_ENDPOINTER: EndpointerConfig = {
  endOfTurnMs: 700,
  pauseMs: 300,
  trustSttFinal: true,
};

export type EndpointerInput =
  { type: 'transcript'; text: string; final: boolean; at: number } | { type: 'tick'; at: number };

export type EndpointerOutcome =
  { type: 'none' } | { type: 'pause'; at: number } | { type: 'endpoint'; text: string; at: number };

const NONE: EndpointerOutcome = { type: 'none' };

export class Endpointer {
  readonly #config: EndpointerConfig;
  #lastSpeechAt: number | undefined;
  #text = '';
  #pauseReported = false;
  #done = false;

  constructor(config: Partial<EndpointerConfig> = {}) {
    this.#config = { ...DEFAULT_ENDPOINTER, ...config };
    // The loop arms its next timer from `wakeAt`, which steps pause → endpoint. If
    // the pause deadline were not strictly earlier, that step would not advance and
    // the loop would re-arm at a time it had already passed, forever.
    if (this.#config.pauseMs >= this.#config.endOfTurnMs) {
      throw new RangeError(
        `pauseMs (${this.#config.pauseMs}) must be below endOfTurnMs (${this.#config.endOfTurnMs})`,
      );
    }
  }

  /**
   * When the caller should next call `observe` with a tick, or `undefined` when
   * nothing is pending. The loop arms a single timer from this rather than polling,
   * so an idle session schedules no work at all.
   */
  get wakeAt(): number | undefined {
    if (this.#done || this.#lastSpeechAt === undefined) return undefined;
    return this.#pauseReported
      ? this.#lastSpeechAt + this.#config.endOfTurnMs
      : this.#lastSpeechAt + this.#config.pauseMs;
  }

  /** Text accumulated for the turn in progress. */
  get pending(): string {
    return this.#text;
  }

  observe(input: EndpointerInput): EndpointerOutcome {
    if (this.#done) return NONE;
    return input.type === 'transcript' ? this.#onTranscript(input) : this.#onTick(input.at);
  }

  reset(): void {
    this.#lastSpeechAt = undefined;
    this.#text = '';
    this.#pauseReported = false;
    this.#done = false;
  }

  #onTranscript(input: Extract<EndpointerInput, { type: 'transcript' }>): EndpointerOutcome {
    // An empty partial is the provider saying "still nothing", not speech. Treating
    // it as speech would hold the turn open through arbitrary silence.
    if (input.text.trim() === '') return NONE;

    this.#text = input.text;
    this.#lastSpeechAt = input.at;
    // Fresh speech retracts the hesitation: this is precisely the mid-sentence-pause
    // case, and re-arming from `pauseMs` again is what makes the assistant wait.
    this.#pauseReported = false;

    if (input.final && this.#config.trustSttFinal) {
      this.#done = true;
      return { type: 'endpoint', text: input.text, at: input.at };
    }
    return NONE;
  }

  #onTick(at: number): EndpointerOutcome {
    const lastSpeechAt = this.#lastSpeechAt;
    if (lastSpeechAt === undefined) return NONE;

    const silence = at - lastSpeechAt;

    if (silence >= this.#config.endOfTurnMs) {
      this.#done = true;
      return { type: 'endpoint', text: this.#text, at };
    }
    if (silence >= this.#config.pauseMs && !this.#pauseReported) {
      this.#pauseReported = true;
      return { type: 'pause', at };
    }
    return NONE;
  }
}
