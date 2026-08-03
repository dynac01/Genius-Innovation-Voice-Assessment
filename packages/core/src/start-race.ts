/**
 * Who wins when both parties start at once.
 *
 * The brief asks that "the user and assistant starting at the same instant
 * resolves without a deadlock or both talking over each other". Two orderings
 * produce that situation and they are easy to conflate:
 *
 *   1. The assistant is already scheduled to speak, and the user starts.
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
 * no state in which both sides wait for the other. The assistant stops, the user
 * finishes, end-of-turn fires, the assistant answers.
 *
 * Firing once per contest rather than once per frame is what stops the other
 * failure: an assistant that re-yields every 20ms would never recover.
 */

export type StartRaceOutcome = 'none' | 'yield';

export class StartRace {
  #contended = false;

  /**
   * @param assistantScheduled Assistant audio is queued or playing. Scheduled
   *   counts: audio handed to the hardware but not yet audible is still a claim
   *   on the turn, and waiting for it to become audible would be too late.
   * @param userSpeaking The detector currently believes the user is talking.
   */
  observe(assistantScheduled: boolean, userSpeaking: boolean): StartRaceOutcome {
    const contended = assistantScheduled && userSpeaking;
    if (contended && !this.#contended) {
      this.#contended = true;
      return 'yield';
    }
    if (!contended) this.#contended = false;
    return 'none';
  }

  /** True while both parties are claiming the turn. */
  get contended(): boolean {
    return this.#contended;
  }

  reset(): void {
    this.#contended = false;
  }
}
