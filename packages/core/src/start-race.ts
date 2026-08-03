/**
 * Who wins when both parties start at once.
 *
 * The brief asks that "the user and assistant starting at the same instant
 * resolves without a deadlock or both talking over each other". Two orderings
 * produce that situation and they are easy to conflate:
 *
 *   1. The assistant is already speaking, and the user starts.
 *      This is ordinary barge-in — a rising edge on user speech.
 *   2. The user is *already* speaking, and the assistant starts.
 *      This is the one that gets missed. There is no rising edge on user speech,
 *      because the detector latched before the assistant existed. An
 *      edge-triggered barge-in never fires and the assistant talks straight over
 *      someone who was mid-sentence.
 *
 * So contention is treated as a *level*, not an edge: the moment both are true,
 * whichever way round they became true, the assistant yields.
 *
 * The rule is "the user always wins", which is the brief's own stated preference
 * — "above all in how the assistant yields the moment the user speaks". It also
 * makes deadlock impossible by construction: yielding is unilateral, so there is
 * no state in which both sides wait for the other.
 *
 * ## Why the two claims are not weighted the same
 *
 * A reply that is *audible* and one that is merely *being composed* have opposite
 * cost profiles, and using one threshold for both is a mistake I made and had to
 * undo:
 *
 * - **Audible.** A late stop is the failure everyone hears, so fire on the
 *   detector's onset and accept the occasional false positive. The cost of being
 *   wrong is a fraction of a second of lost audio.
 * - **Silent (thinking).** Nothing is being talked over, so there is no late-stop
 *   cost to race against — and a false positive silently destroys a reply the
 *   user is waiting for, with no sound to explain why. Here the cheap thing is to
 *   be *sure*, so speech must be sustained rather than merely detected.
 *
 * A cough, a chair, a door, the tail of the user's own last word: all of these
 * trip a detector tuned for onset. None of them survives a few hundred
 * milliseconds of "is that still happening?".
 */

export type StartRaceOutcome = 'none' | 'yield';

export interface StartRaceConfig {
  /**
   * Sustained user speech required to abandon a reply that is not yet audible.
   *
   * Costs nothing perceptible: the assistant is silent throughout, so the user
   * hears no delay. It buys immunity to every short noise in a real room.
   */
  readonly confirmWhileSilentMs: number;
}

export const DEFAULT_START_RACE: StartRaceConfig = { confirmWhileSilentMs: 400 };

export interface StartRaceInput {
  /** Assistant audio is queued or playing. */
  readonly assistantAudible: boolean;
  /** The assistant has claimed the turn but is not making sound yet. */
  readonly assistantThinking: boolean;
  readonly userSpeaking: boolean;
  /** Duration this observation covers, so sustained speech can be measured. */
  readonly frameMs: number;
}

export class StartRace {
  readonly #config: StartRaceConfig;
  #contended = false;
  #sustainedMs = 0;

  constructor(config: Partial<StartRaceConfig> = {}) {
    this.#config = { ...DEFAULT_START_RACE, ...config };
  }

  observe(input: StartRaceInput): StartRaceOutcome {
    if (!input.userSpeaking) {
      this.#contended = false;
      this.#sustainedMs = 0;
      return 'none';
    }

    this.#sustainedMs += input.frameMs;

    // Audible: yield on contention, immediately.
    if (input.assistantAudible) return this.#claim();

    // Silent: yield only once the speech has proved itself.
    if (input.assistantThinking && this.#sustainedMs >= this.#config.confirmWhileSilentMs) {
      return this.#claim();
    }

    if (!input.assistantThinking) this.#contended = false;
    return 'none';
  }

  /** True while both parties are claiming the turn. */
  get contended(): boolean {
    return this.#contended;
  }

  reset(): void {
    this.#contended = false;
    this.#sustainedMs = 0;
  }

  /** Fires once per contest — re-yielding every frame would stop the assistant recovering. */
  #claim(): StartRaceOutcome {
    if (this.#contended) return 'none';
    this.#contended = true;
    return 'yield';
  }
}
