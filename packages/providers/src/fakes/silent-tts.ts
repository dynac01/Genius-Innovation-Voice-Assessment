import type { AudioChunk, Clock, TTS } from '@voice/core';
import { samplesForMs } from '@voice/core';

export interface SilentTtsOptions {
  readonly clock: Clock;
  readonly sampleRate?: number;
  /** Playtime represented by each emitted frame. */
  readonly frameMs?: number;
  /** Speaking rate. ~15 chars/sec is close to a natural 180wpm. */
  readonly charsPerSecond?: number;
  /** Time to first byte — models the provider's synthesis latency. */
  readonly ttfbMs?: number;
}

/** What one `synthesizeStream` call was asked, and how much of it was heard. */
export interface TtsRequest {
  readonly text: string;
  readonly totalFrames: number;
  framesEmitted: number;
  /**
   * Characters covered by the frames actually emitted before the consumer stopped.
   *
   * This is the played-through offset criterion 2 turns on: resuming an interrupted
   * reply means continuing from what the user *heard*, and this is that number.
   */
  charsEmitted: number;
  /** False when the consumer stopped iterating early — a barge-in. */
  completed: boolean;
}

/**
 * A text-to-speech provider that emits correctly-shaped silence.
 *
 * The pacing is load-bearing. A fake that returned all its audio instantly would
 * make every barge-in test pass trivially, because there would be no window during
 * which to interrupt. So frames are emitted at realtime pacing, and each carries
 * the character span it renders.
 *
 * Real streaming providers run *ahead* of realtime; the loop must not assume
 * otherwise, which is why the emission rate is configurable rather than fixed.
 */
export class SilentTts implements TTS {
  readonly requests: TtsRequest[] = [];

  readonly #clock: Clock;
  readonly #sampleRate: number;
  readonly #frameMs: number;
  readonly #charsPerSecond: number;
  readonly #ttfbMs: number;

  constructor(options: SilentTtsOptions) {
    this.#clock = options.clock;
    this.#sampleRate = options.sampleRate ?? 24_000;
    this.#frameMs = options.frameMs ?? 20;
    this.#charsPerSecond = options.charsPerSecond ?? 15;
    this.#ttfbMs = options.ttfbMs ?? 60;
  }

  get lastRequest(): TtsRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  async *synthesizeStream(text: string): AsyncIterable<AudioChunk> {
    const totalFrames =
      text.length === 0
        ? 0
        : Math.max(1, Math.ceil((text.length / this.#charsPerSecond) * (1000 / this.#frameMs)));

    const request: TtsRequest = {
      text,
      totalFrames,
      framesEmitted: 0,
      charsEmitted: 0,
      completed: false,
    };
    this.requests.push(request);

    if (totalFrames === 0) {
      request.completed = true;
      return;
    }

    const pcm = new Int16Array(samplesForMs(this.#frameMs, this.#sampleRate));

    await this.#clock.sleep(this.#ttfbMs);
    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (frame > 0) await this.#clock.sleep(this.#frameMs);

      const start = Math.floor((frame * text.length) / totalFrames);
      const end = Math.floor(((frame + 1) * text.length) / totalFrames);

      request.framesEmitted += 1;
      request.charsEmitted = end;

      // A fresh view per frame: sharing one buffer would let a consumer that
      // retains chunks observe them mutate underneath it.
      yield { pcm: pcm.slice(), sampleRate: this.#sampleRate, span: { start, end } };
    }
    request.completed = true;
  }
}
