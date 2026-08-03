import { describe, expect, it } from 'vitest';

import { toInt16Samples } from './ws-binary.js';

/** Samples that are unmistakably not silence, and not symmetric. */
const SAMPLES = [1, -2, 3_000, -16_000, 32_767, -32_768, 7, -9];

function encoded(): Buffer {
  const buffer = Buffer.alloc(SAMPLES.length * 2);
  SAMPLES.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

/**
 * The test that was missing, and its absence cost more than every other gap in the
 * project combined.
 *
 * Everything downstream verified *shape*: frames arrived, of the right size, at the
 * right cadence, with the right spans. All of that stayed true while the payload
 * was silence, because a decoder that copies nothing into a correctly-sized buffer
 * satisfies every check that counts frames.
 *
 * So these assert content. Each case feeds a shape `ws` can actually deliver and
 * requires the samples to come out the other side unchanged.
 */
describe('toInt16Samples', () => {
  it('preserves samples from a Node Buffer', () => {
    expect(Array.from(toInt16Samples(encoded()))).toEqual(SAMPLES);
  });

  it('preserves samples from a raw ArrayBuffer', () => {
    // The shape that produced silence: `binaryType = 'arraybuffer'` means `ws`
    // delivers this, and it has neither `.buffer` nor `.byteOffset`.
    const source = encoded();
    const arrayBuffer = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ) as ArrayBuffer;

    expect(Array.from(toInt16Samples(arrayBuffer))).toEqual(SAMPLES);
  });

  it('preserves samples from a fragmented message', () => {
    const whole = encoded();
    const parts = [whole.subarray(0, 6), whole.subarray(6, 10), whole.subarray(10)];
    expect(Array.from(toInt16Samples(parts))).toEqual(SAMPLES);
  });

  it('preserves samples from a Buffer that is a window onto a larger pool', () => {
    // Node pools small allocations, so a Buffer is frequently a view at a non-zero
    // offset into a shared block. Ignoring the offset reads someone else's bytes.
    const pool = Buffer.alloc(64, 0xaa);
    const payload = encoded();
    payload.copy(pool, 24);

    expect(Array.from(toInt16Samples(pool.subarray(24, 24 + payload.length)))).toEqual(SAMPLES);
  });

  it('does not alias the source, which may be reused before the frame is consumed', () => {
    const source = encoded();
    const decoded = toInt16Samples(source);
    source.fill(0);
    expect(Array.from(decoded)).toEqual(SAMPLES);
  });

  it('drops a trailing odd byte rather than inventing half a sample', () => {
    const truncated = Buffer.concat([encoded(), Buffer.from([0x7f])]);
    expect(Array.from(toInt16Samples(truncated))).toEqual(SAMPLES);
  });

  it('returns nothing for an empty message', () => {
    expect(toInt16Samples(Buffer.alloc(0)).length).toBe(0);
    expect(toInt16Samples(new ArrayBuffer(0)).length).toBe(0);
  });

  /** The blunt version of the whole story. */
  it('never turns audio into silence', () => {
    const source = encoded();
    const arrayBuffer = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ) as ArrayBuffer;

    for (const shape of [source, arrayBuffer, [source]]) {
      const decoded = toInt16Samples(shape as never);
      expect(decoded.length).toBeGreaterThan(0);
      expect(
        decoded.some((sample) => sample !== 0),
        'decoded to pure silence',
      ).toBe(true);
    }
  });
});
