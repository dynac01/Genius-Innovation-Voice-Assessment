import type { AudioChunk, AudioStream, Clock } from '@voice/core';
import { samplesForMs } from '@voice/core';

export interface FakeMicrophoneOptions {
  readonly clock: Clock;
  /** Total audio to produce. Finite by design — see below. */
  readonly durationMs: number;
  readonly sampleRate?: number;
  readonly frameMs?: number;
}

/**
 * A microphone that produces silence at realtime pacing.
 *
 * Stands in for the browser capture path so the pipeline can be driven with no
 * audio device. Deliberately **finite**: an endless source would keep
 * `runUntilIdle` scheduling forever, turning a failing test into a hanging one.
 * Tests that need a long-lived mic ask for a long duration rather than an infinite
 * one, so the runaway guard still has something to catch.
 */
export function fakeMicrophone(options: FakeMicrophoneOptions): AudioStream {
  const sampleRate = options.sampleRate ?? 16_000;
  const frameMs = options.frameMs ?? 20;
  const frames = Math.floor(options.durationMs / frameMs);
  const pcm = new Int16Array(samplesForMs(frameMs, sampleRate));

  return (async function* (): AsyncIterable<AudioChunk> {
    for (let frame = 0; frame < frames; frame += 1) {
      await options.clock.sleep(frameMs);
      yield { pcm: pcm.slice(), sampleRate };
    }
  })();
}
