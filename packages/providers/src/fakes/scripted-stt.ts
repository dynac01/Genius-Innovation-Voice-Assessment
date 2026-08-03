import type { AudioChunk, AudioStream, Clock, STT } from '@voice/core';

/** One scripted emission: wait `afterMs` on the clock, then yield this result. */
export interface SttScriptStep {
  readonly afterMs: number;
  readonly text: string;
  readonly final: boolean;
}

export interface ScriptedSttOptions {
  readonly clock: Clock;
  readonly script: readonly SttScriptStep[];
}

/**
 * A speech-to-text provider that ignores the audio and says what it was told to.
 *
 * The timing is the point. Criterion 4 — "does not cut in during a brief
 * mid-sentence pause" — is a statement about *when* results arrive, so a fake that
 * returned a transcript instantly could not express the case being tested. A script
 * of `{afterMs}` steps lets a test say "partial, 400ms gap, more speech" exactly.
 *
 * It still drains the audio stream it is given, and records what it saw. Nothing
 * about the capture path is skipped in fake mode; only the transcription result is
 * scripted. `consumed` is there so a test can prove audio actually flowed.
 */
export class ScriptedStt implements STT {
  readonly consumed: AudioChunk[] = [];

  readonly #clock: Clock;
  readonly #script: readonly SttScriptStep[];

  constructor(options: ScriptedSttOptions) {
    this.#clock = options.clock;
    this.#script = options.script;
  }

  async *transcribeStream(audio: AudioStream): AsyncIterable<{ text: string; final: boolean }> {
    let listening = true;

    // Drain concurrently rather than sequentially: a real STT consumes audio while
    // it emits, and a fake that awaited the whole stream first would deadlock any
    // test whose microphone outlives the utterance.
    const draining = (async () => {
      for await (const chunk of audio) {
        if (!listening) break;
        this.consumed.push(chunk);
      }
    })();
    void draining.catch(() => {
      /* the consumer stopping first is not an error */
    });

    try {
      for (const step of this.#script) {
        await this.#clock.sleep(step.afterMs);
        yield { text: step.text, final: step.final };
      }

      // Stay open past the end of the script, until the microphone itself ends.
      // A real streaming STT holds its connection for the whole session; a fake that
      // closed after its last result would end the loop's input stream the instant
      // the user stopped talking — taking the silence-based endpointer with it, and
      // making criterion 4 untestable for the wrong reason.
      await draining;
    } finally {
      listening = false;
    }
  }
}
