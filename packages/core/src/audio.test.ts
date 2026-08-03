import { describe, expect, it } from 'vitest';

import { chunkDurationMs, samplesForMs, silentFrame, totalDurationMs } from './audio.js';
import type { AudioChunk } from './audio.js';

const frame = (ms: number, sampleRate = 24_000): AudioChunk => ({
  pcm: silentFrame(ms, sampleRate),
  sampleRate,
});

describe('audio primitives', () => {
  it.each([
    [20, 24_000, 480],
    [20, 16_000, 320],
    [10, 48_000, 480],
    [0, 24_000, 0],
  ])('samplesForMs(%ims @ %iHz) = %i', (ms, rate, expected) => {
    expect(samplesForMs(ms, rate)).toBe(expected);
  });

  it('round-trips a frame duration', () => {
    expect(chunkDurationMs(frame(20))).toBeCloseTo(20, 6);
    expect(chunkDurationMs(frame(20, 16_000))).toBeCloseTo(20, 6);
  });

  it('sums durations across frames', () => {
    expect(totalDurationMs([frame(20), frame(20), frame(10)])).toBeCloseTo(50, 6);
  });

  it('sums to zero for no frames', () => {
    expect(totalDurationMs([])).toBe(0);
  });

  it('emits actual silence, not uninitialised memory', () => {
    const pcm = silentFrame(20, 24_000);
    expect(pcm).toHaveLength(480);
    expect(pcm.every((s) => s === 0)).toBe(true);
  });
});
