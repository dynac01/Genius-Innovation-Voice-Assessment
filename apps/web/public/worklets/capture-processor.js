/**
 * Microphone capture worklet.
 *
 * Runs on the audio thread, so it must never allocate unpredictably or block. It
 * accumulates the 128-sample blocks the graph delivers into fixed-size frames and
 * posts them to the main thread as Int16, halving transfer size versus Float32 and
 * matching the wire format exactly — no conversion later, on either side.
 *
 * Plain JavaScript in `public/` rather than TypeScript in `src/` on purpose:
 * `audioWorklet.addModule` takes a URL the browser fetches directly, and routing
 * that through the bundler is the kind of dev-versus-build discrepancy that only
 * shows up in production. A served static file behaves identically in dev, in a
 * production build, and behind Codespaces port forwarding.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameSamples = options?.processorOptions?.frameSamples ?? 320;
    this._frame = new Int16Array(frameSamples);
    this._filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      // Clamp before scaling: a sample slightly outside [-1, 1] would wrap to the
      // opposite rail as a loud click, which reads as a hardware fault.
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this._frame[this._filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this._filled += 1;

      if (this._filled === this._frame.length) {
        const out = this._frame.slice();
        // `currentTime` is the audio clock at the start of this render quantum —
        // the same clock the playback ramp is scheduled against. Stamping the frame
        // here is what makes the barge-in measurement real rather than inferred:
        // capture and stop are then two readings of one clock, with no thread-hop
        // guesswork in between.
        this.port.postMessage({ pcm: out, capturedAt: currentTime }, [out.buffer]);
        this._filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
