import { describe, expect, it } from 'vitest';

import { Resampler } from './resample.js';

/** A sine at `hz`, `samples` long, at `rate`. */
function sine(hz: number, rate: number, samples: number, offset = 0): Int16Array {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * (i + offset)) / rate) * 16_000);
  }
  return pcm;
}

function peak(frame: Float32Array): number {
  let max = 0;
  for (const sample of frame) max = Math.max(max, Math.abs(sample));
  return max;
}

/** Largest jump between adjacent samples — a discontinuity detector. */
function maxStep(frame: Float32Array): number {
  let max = 0;
  for (let i = 1; i < frame.length; i += 1) {
    max = Math.max(max, Math.abs((frame[i] ?? 0) - (frame[i - 1] ?? 0)));
  }
  return max;
}

describe('Resampler', () => {
  it('passes through untouched when the rates match', () => {
    const resampler = new Resampler(24_000, 24_000);
    expect(resampler.passthrough).toBe(true);

    const input = sine(440, 24_000, 480);
    const output = resampler.process(input);

    expect(output.length).toBe(input.length);
    expect(output[100]).toBeCloseTo((input[100] ?? 0) / 0x7fff, 4);
  });

  it('produces roughly the output-rate number of samples', () => {
    const resampler = new Resampler(24_000, 44_100);
    const output = resampler.process(sine(440, 24_000, 960));
    // 960 input samples at 24kHz is 40ms; 40ms at 44.1kHz is 1764 samples.
    expect(output.length).toBeGreaterThan(1_750);
    expect(output.length).toBeLessThan(1_780);
  });

  it('preserves amplitude', () => {
    const resampler = new Resampler(24_000, 44_100);
    const input = sine(440, 24_000, 2_400);
    expect(peak(resampler.process(input))).toBeCloseTo(
      peak(new Float32Array([16_000 / 0x7fff])),
      1,
    );
  });

  it('preserves frequency', () => {
    const resampler = new Resampler(24_000, 48_000);
    const output = resampler.process(sine(1_000, 24_000, 24_000));

    // Zero crossings are a cheap, assumption-free frequency check: a 1kHz tone
    // over one second crosses zero about 2000 times whatever the sample rate.
    let crossings = 0;
    for (let i = 1; i < output.length; i += 1) {
      const previous = output[i - 1] ?? 0;
      const current = output[i] ?? 0;
      if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
    }
    expect(crossings).toBeGreaterThan(1_950);
    expect(crossings).toBeLessThan(2_050);
  });

  /**
   * The reason this class is stateful.
   *
   * Audio arrives in 40ms frames. A resampler that treats each frame as an
   * independent signal has nothing to interpolate the first sample against, so it
   * inserts a discontinuity at every boundary — 25 a second, which is heard as a
   * buzz rather than as an obvious fault, and therefore ships.
   */
  it('joins consecutive frames without a discontinuity', () => {
    const rate = 24_000;
    const frameSamples = 960;
    const resampler = new Resampler(rate, 44_100);

    // One continuous sine, delivered in frames — the phase carries across.
    const joined: number[] = [];
    for (let frame = 0; frame < 6; frame += 1) {
      const chunk = sine(440, rate, frameSamples, frame * frameSamples);
      joined.push(...resampler.process(chunk));
    }
    const stream = Float32Array.from(joined);

    // A 440Hz sine at 44.1kHz steps by at most ~2πf/rate ≈ 0.063 of full scale per
    // sample. A frame-boundary discontinuity is an order of magnitude larger.
    expect(maxStep(stream)).toBeLessThan(0.05);
  });

  it('is continuous across a frame boundary specifically', () => {
    const resampler = new Resampler(24_000, 44_100);
    const first = resampler.process(sine(440, 24_000, 960, 0));
    const second = resampler.process(sine(440, 24_000, 960, 960));

    const seam = Math.abs((second[0] ?? 0) - (first[first.length - 1] ?? 0));
    expect(seam).toBeLessThan(0.05);
  });

  it('handles an empty frame without disturbing the stream', () => {
    const resampler = new Resampler(24_000, 44_100);
    resampler.process(sine(440, 24_000, 960, 0));
    expect(resampler.process(new Int16Array(0)).length).toBe(0);

    const after = resampler.process(sine(440, 24_000, 960, 960));
    expect(maxStep(after)).toBeLessThan(0.05);
  });

  it('renders silence as silence rather than as noise', () => {
    const resampler = new Resampler(24_000, 44_100);
    expect(peak(resampler.process(new Int16Array(960)))).toBe(0);
  });

  it('forgets its tail on reset, so a discarded reply cannot bleed into the next', () => {
    const resampler = new Resampler(24_000, 44_100);
    resampler.process(new Int16Array(960).fill(16_000));
    resampler.reset();

    // Starting from silence after a reset must stay at silence; a carried tail
    // would ramp down from the old level and click.
    expect(peak(resampler.process(new Int16Array(960)))).toBe(0);
  });

  it('rejects nonsensical rates rather than producing quiet garbage', () => {
    expect(() => new Resampler(0, 44_100)).toThrow(RangeError);
    expect(() => new Resampler(24_000, -1)).toThrow(RangeError);
  });
});
