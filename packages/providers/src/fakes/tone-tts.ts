import type { AudioChunk, Clock, TTS } from '@voice/core';
import { samplesForMs } from '@voice/core';

export interface ToneTtsOptions {
  readonly clock: Clock;
  readonly sampleRate?: number;
  readonly frameMs?: number;
  readonly charsPerSecond?: number;
  readonly ttfbMs?: number;
  /** Carrier frequency. Low enough to be pleasant, high enough to hear on a phone. */
  readonly frequencyHz?: number;
  readonly amplitude?: number;
}

export interface ToneRequest {
  readonly text: string;
  readonly totalFrames: number;
  framesEmitted: number;
  charsEmitted: number;
  completed: boolean;
}

/**
 * The audible sibling of {@link SilentTts}.
 *
 * Identical timing, spans, and stop-accounting — it just emits a continuous tone
 * instead of zeroes. Silence is right for CI, where nobody is listening and the
 * assertion is about control flow. It is useless for the Phase 2 risk gate, which
 * asks whether a real phone actually plays server-sent audio: you cannot verify
 * playback by ear when there is nothing to hear.
 *
 * Phase-continuous across frames, so the tone does not click at frame boundaries
 * and mask the very artefacts the barge-in ramp exists to avoid.
 */
export class ToneTts implements TTS {
  readonly requests: ToneRequest[] = [];

  readonly #clock: Clock;
  readonly #sampleRate: number;
  readonly #frameMs: number;
  readonly #charsPerSecond: number;
  readonly #ttfbMs: number;
  readonly #frequencyHz: number;
  readonly #amplitude: number;

  constructor(options: ToneTtsOptions) {
    this.#clock = options.clock;
    this.#sampleRate = options.sampleRate ?? 24_000;
    this.#frameMs = options.frameMs ?? 20;
    this.#charsPerSecond = options.charsPerSecond ?? 15;
    this.#ttfbMs = options.ttfbMs ?? 60;
    this.#frequencyHz = options.frequencyHz ?? 220;
    this.#amplitude = options.amplitude ?? 0.18;
  }

  get lastRequest(): ToneRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  async *synthesizeStream(text: string): AsyncIterable<AudioChunk> {
    const totalFrames =
      text.length === 0
        ? 0
        : Math.max(1, Math.ceil((text.length / this.#charsPerSecond) * (1000 / this.#frameMs)));

    const request: ToneRequest = {
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

    const frameSamples = samplesForMs(this.#frameMs, this.#sampleRate);
    const step = (2 * Math.PI * this.#frequencyHz) / this.#sampleRate;
    const peak = Math.round(this.#amplitude * 32_767);
    let phase = 0;

    await this.#clock.sleep(this.#ttfbMs);
    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (frame > 0) await this.#clock.sleep(this.#frameMs);

      const pcm = new Int16Array(frameSamples);
      for (let i = 0; i < frameSamples; i += 1) {
        pcm[i] = Math.round(Math.sin(phase) * peak);
        phase += step;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }

      const start = Math.floor((frame * text.length) / totalFrames);
      const end = Math.floor(((frame + 1) * text.length) / totalFrames);

      request.framesEmitted += 1;
      request.charsEmitted = end;

      yield { pcm, sampleRate: this.#sampleRate, span: { start, end } };
    }
    request.completed = true;
  }
}
