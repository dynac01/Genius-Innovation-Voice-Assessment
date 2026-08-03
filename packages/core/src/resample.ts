/**
 * Sample-rate conversion for the playback path.
 *
 * ## Why this exists rather than letting the browser do it
 *
 * The Web Audio spec says an `AudioBuffer` may declare its own sample rate and
 * that an `AudioBufferSourceNode` resamples it to the context's rate on playback.
 * That is true, it is the obvious way to play 24kHz synthesis in a 44.1kHz
 * context, and it is what this project did.
 *
 * A session log showed what it actually does. Speech buffers at 24000 Hz in a
 * 44100 Hz context: measured output peak 0.000, every sample, across three
 * replies, while the queue drained normally at gain 1 in a running context. A
 * plain tone built at the *context's* rate, played through the same gain node in
 * the same instant: 0.25. The only difference between the two was the buffer's
 * declared rate.
 *
 * Whether that is a browser defect or an under-specified corner is not worth
 * arguing about, because the conclusion is the same either way: an implicit
 * conversion that silently yields silence is not something to depend on. The
 * failure has no exception, no console warning, and no observable symptom short
 * of a person saying they cannot hear anything — which is the most expensive
 * possible way to find out.
 *
 * So the conversion happens here, in code that can be unit tested, and every
 * buffer handed to Web Audio is built at exactly the context's rate. The browser
 * is then never asked to convert anything.
 *
 * ## Why it is stateful
 *
 * Audio arrives as a stream of small frames — 40ms at a time — and interpolation
 * needs the sample *before* the one it is producing. Resampling each frame
 * independently means every frame boundary interpolates from nothing, which puts a
 * discontinuity into the signal 25 times a second. That is audible, and it is
 * audible as a buzz rather than as an obvious defect, so it is the kind of thing
 * that ships. The tail sample and the fractional read position carry across calls.
 *
 * ## Limits, stated
 *
 * Linear interpolation with no anti-aliasing filter. That is correct for
 * *upsampling*, which is the only case here — synthesis runs at 24kHz and output
 * devices run at 44.1 or 48 — and it would alias on the way down. A downsampling
 * path would need a low-pass first; there isn't one, so this doesn't carry the
 * weight of pretending otherwise.
 */

/** Int16 → float, matching the asymmetric range of two's complement. */
function toFloat(sample: number): number {
  return sample < 0 ? sample / 0x8000 : sample / 0x7fff;
}

export class Resampler {
  readonly #ratio: number;
  /** Last sample of the previous chunk — the left neighbour for the first output. */
  #prev = 0;
  /**
   * Read position for the next output sample, relative to the start of the next
   * chunk. Sits in [-1, 0) between calls: -1 is the carried tail, 0 is the first
   * sample of whatever arrives next.
   */
  #pos = 0;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {
    if (fromRate <= 0 || toRate <= 0) {
      throw new RangeError(`rates must be positive: ${fromRate} → ${toRate}`);
    }
    this.#ratio = fromRate / toRate;
  }

  /** True when no conversion is needed and frames pass through untouched. */
  get passthrough(): boolean {
    return this.fromRate === this.toRate;
  }

  process(pcm: Int16Array): Float32Array {
    const length = pcm.length;
    if (length === 0) return new Float32Array(0);

    if (this.passthrough) {
      const direct = new Float32Array(length);
      for (let i = 0; i < length; i += 1) direct[i] = toFloat(pcm[i] ?? 0);
      return direct;
    }

    const at = (index: number): number => (index < 0 ? this.#prev : toFloat(pcm[index] ?? 0));

    // Outputs are produced while the read position still has a right neighbour
    // inside this chunk. Anything past that waits for the next one rather than
    // being invented, which is what keeps the stream continuous.
    const count = Math.max(0, Math.ceil((length - 1 - this.#pos) / this.#ratio));
    const out = new Float32Array(count);

    let pos = this.#pos;
    for (let k = 0; k < count; k += 1) {
      const index = Math.floor(pos);
      const fraction = pos - index;
      out[k] = at(index) * (1 - fraction) + at(index + 1) * fraction;
      pos += this.#ratio;
    }

    this.#prev = toFloat(pcm[length - 1] ?? 0);
    // Re-origin onto the next chunk. `pos` lands in [length - 1, length), so this
    // returns to [-1, 0) and the carried tail becomes index -1 again.
    this.#pos = pos - length;
    return out;
  }

  /**
   * Forget the carried tail.
   *
   * Called when playback is abandoned, so the last sample of a discarded reply
   * cannot be interpolated into the first sample of the next one — a small click,
   * but one that would land exactly on the resumption after every barge-in.
   */
  reset(): void {
    this.#prev = 0;
    this.#pos = 0;
  }
}
