/**
 * The browser audio path: capture in, playback out, and the ability to go silent
 * immediately.
 *
 * Kept thin on purpose. Every *decision* — is this speech, has the turn ended,
 * where do we resume — lives as pure logic in @voice/core where it can be unit
 * tested. What remains here is the part jsdom cannot fake and a real browser must
 * prove: `getUserMedia`, an `AudioWorklet`, and a scheduling queue. See
 * docs/TESTING.md §2.
 */

import { DEFAULT_VAD, Vad } from '@voice/core';
import type { EarconSound } from '@voice/core';

import { EarconPlayer } from './earcons.js';

/** Requested capture rate. Most browsers honour it; we report whatever we get. */
const PREFERRED_SAMPLE_RATE = 16_000;

/** 20ms at 16kHz. Small frames keep the barge-in stop granular. */
const CAPTURE_FRAME_SAMPLES = 320;

/**
 * How far ahead of the playhead audio is scheduled.
 *
 * This is the barge-in tax made explicit: nothing already handed to the hardware
 * can be recalled, so the buffer is the floor on how much audio can still be heard
 * after a stop. Short enough that the tail is imperceptible, long enough to absorb
 * ordinary network jitter. Phase 4 tunes it against measurements.
 */
const JITTER_BUFFER_MS = 120;

/** Fade applied on barge-in. A hard cut at a non-zero sample is an audible click. */
const STOP_RAMP_MS = 12;

export type MicPermission = 'unknown' | 'granted' | 'denied' | 'unavailable';

export interface AudioEngineHandlers {
  onFrame: (pcm: Int16Array) => void;
  onPermissionChange?: (permission: MicPermission) => void;
  /**
   * The user started speaking while the assistant was audible.
   *
   * Fired *after* output has already been silenced locally. The server is being
   * told what happened, not asked what to do — asking would spend the entire
   * latency budget on a round trip before anything stopped.
   */
  onBargeIn?: (measurement: BargeInMeasurement) => void;
}

/**
 * A measured barge-in, in milliseconds.
 *
 * Both numbers come from the audio clock, so neither includes thread-hop
 * guesswork — but they measure different things and the distinction matters:
 *
 * - `detectToSilent` is what the machine did: the frame that tripped the detector
 *   completed at a known audio time, and the gain ramp finishes at another.
 * - `onsetToSilent` adds the evidence the detector needed before it could fire.
 *   The user started talking roughly `onsetMs` before detection, so this is the
 *   honest end-to-end figure — the one to compare against the ~300ms target.
 */
export interface BargeInMeasurement {
  readonly detectToSilent: number;
  readonly onsetToSilent: number;
}

export class MicrophoneError extends Error {
  constructor(
    message: string,
    readonly permission: MicPermission,
  ) {
    super(message);
    this.name = 'MicrophoneError';
  }
}

interface Scheduled {
  readonly source: AudioBufferSourceNode;
  readonly startedAt: number;
  readonly endsAt: number;
}

export class AudioEngine {
  #context: AudioContext | undefined;
  #stream: MediaStream | undefined;
  #capture: AudioWorkletNode | undefined;
  #sink: GainNode | undefined;
  #output: GainNode | undefined;
  #scheduled: Scheduled[] = [];
  #nextStartAt = 0;
  readonly #vad = new Vad();
  #earcons: EarconPlayer | undefined;
  #lastBargeIn: BargeInMeasurement | undefined;

  get sampleRate(): number {
    return this.#context?.sampleRate ?? 0;
  }

  get running(): boolean {
    return this.#context?.state === 'running';
  }

  get lastBargeIn(): BargeInMeasurement | undefined {
    return this.#lastBargeIn;
  }

  /** True while assistant audio is scheduled at or ahead of the playhead. */
  get outputActive(): boolean {
    return this.bufferedAheadMs > 0;
  }

  /**
   * Must be called from inside a user gesture.
   *
   * iOS Safari will construct an AudioContext anywhere but leaves it suspended, and
   * only a genuine user activation resumes it. Calling this from a click handler is
   * the whole reason the demo has a Start button rather than auto-starting.
   */
  async start(handlers: AudioEngineHandlers): Promise<void> {
    if (this.#context !== undefined) return;

    const stream = await this.#requestMicrophone(handlers.onPermissionChange);

    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: PREFERRED_SAMPLE_RATE, latencyHint: 'interactive' });
    } catch {
      // Some browsers reject an explicit rate. Take the default and tell the server
      // what we actually got rather than resampling and inviting artefacts.
      context = new AudioContext({ latencyHint: 'interactive' });
    }
    if (context.state === 'suspended') await context.resume();

    await context.audioWorklet.addModule('/worklets/capture-processor.js');

    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { frameSamples: CAPTURE_FRAME_SAMPLES },
    });
    const frameMs = (CAPTURE_FRAME_SAMPLES / context.sampleRate) * 1000;
    capture.port.onmessage = (event: MessageEvent<{ pcm: Int16Array; capturedAt: number }>) => {
      const { pcm, capturedAt } = event.data;

      // Run the detector before forwarding. Barge-in is decided here, in the
      // browser, because the round trip alone would exhaust the latency budget.
      const wasSpeaking = this.outputActive;
      this.#vad.setOutputActive(wasSpeaking);
      const verdict = this.#vad.process(pcm, frameMs);

      if (verdict === 'speech_start' && wasSpeaking) {
        const silentAt = this.flush();
        this.#lastBargeIn = {
          detectToSilent: Math.max(0, (silentAt - capturedAt) * 1000),
          onsetToSilent: Math.max(0, (silentAt - capturedAt) * 1000) + DEFAULT_VAD.onsetMs,
        };
        handlers.onBargeIn?.(this.#lastBargeIn);
      }

      handlers.onFrame(pcm);
    };

    // A muted sink keeps the worklet pulled by the graph without routing the
    // microphone to the speakers, which would be an instant feedback loop.
    const sink = context.createGain();
    sink.gain.value = 0;

    const output = context.createGain();
    output.gain.value = 1;
    output.connect(context.destination);

    source.connect(capture);
    capture.connect(sink);
    sink.connect(context.destination);

    this.#earcons = new EarconPlayer(context);

    this.#context = context;
    this.#stream = stream;
    this.#capture = capture;
    this.#sink = sink;
    this.#output = output;
    this.#nextStartAt = 0;
  }

  /**
   * Play a state sound.
   *
   * Routed through its own node, parallel to speech, so it can neither be silenced
   * by a barge-in ramp nor duck the reply it plays over.
   */
  playEarcon(sound: EarconSound): void {
    this.#earcons?.play(sound);
  }

  /** Queue a frame of assistant audio behind whatever is already scheduled. */
  play(pcm: Int16Array, sampleRate: number): void {
    const context = this.#context;
    const output = this.#output;
    if (context === undefined || output === undefined || pcm.length === 0) return;

    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      const sample = pcm[i] ?? 0;
      channel[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(output);

    const earliest = context.currentTime + JITTER_BUFFER_MS / 1000;
    const startAt = Math.max(this.#nextStartAt, earliest);
    source.start(startAt);

    const endsAt = startAt + buffer.duration;
    this.#nextStartAt = endsAt;
    this.#scheduled.push({ source, startedAt: startAt, endsAt });
    source.onended = () => {
      this.#scheduled = this.#scheduled.filter((entry) => entry.source !== source);
    };
  }

  /**
   * Stop assistant audio now.
   *
   * Ramps rather than cuts, then stops the scheduled sources once the ramp has
   * finished. The brief asks for no audio tail; a hard cut mid-waveform produces a
   * click, which is its own kind of tail.
   */
  flush(): number {
    const context = this.#context;
    const output = this.#output;
    if (context === undefined || output === undefined) return 0;

    const now = context.currentTime;
    const rampEnd = now + STOP_RAMP_MS / 1000;

    output.gain.cancelScheduledValues(now);
    output.gain.setValueAtTime(output.gain.value, now);
    output.gain.linearRampToValueAtTime(0, rampEnd);

    for (const entry of this.#scheduled) {
      try {
        entry.source.stop(rampEnd);
      } catch {
        // Already stopped or never started; nothing to unwind.
      }
    }
    this.#scheduled = [];
    this.#nextStartAt = 0;

    // Restore gain strictly after every stop has taken effect, so the next reply is
    // audible without unmuting anything still in flight.
    output.gain.setValueAtTime(1, rampEnd + 0.001);

    // The audio-clock time at which output is genuinely silent.
    return rampEnd;
  }

  /** Seconds of assistant audio still queued ahead of the playhead. */
  get bufferedAheadMs(): number {
    const context = this.#context;
    if (context === undefined || this.#scheduled.length === 0) return 0;
    const last = this.#scheduled[this.#scheduled.length - 1];
    if (last === undefined) return 0;
    return Math.max(0, (last.endsAt - context.currentTime) * 1000);
  }

  async stop(): Promise<void> {
    this.flush();
    if (this.#capture !== undefined) this.#capture.port.onmessage = null;
    this.#capture?.disconnect();
    this.#sink?.disconnect();
    this.#output?.disconnect();
    this.#earcons?.disconnect();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    await this.#context?.close();

    this.#context = undefined;
    this.#stream = undefined;
    this.#capture = undefined;
    this.#sink = undefined;
    this.#output = undefined;
    this.#earcons = undefined;
    this.#scheduled = [];
    this.#nextStartAt = 0;
  }

  async #requestMicrophone(onChange?: (permission: MicPermission) => void): Promise<MediaStream> {
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      onChange?.('unavailable');
      throw new MicrophoneError(
        window.isSecureContext
          ? 'This browser has no microphone API.'
          : 'Microphone access needs HTTPS. Open the page over a secure connection.',
        'unavailable',
      );
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Acoustic echo cancellation is what stops the assistant's own voice
          // arriving back through the microphone and self-triggering barge-in.
          // Without it the demo interrupts itself, on the criterion weighted hardest.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      onChange?.('granted');
      void this.#watchPermission(onChange);
      return stream;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        onChange?.('denied');
        throw new MicrophoneError(
          'Microphone permission was refused. Allow it in your browser’s site settings and try again.',
          'denied',
        );
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        onChange?.('unavailable');
        throw new MicrophoneError('No microphone was found on this device.', 'unavailable');
      }
      onChange?.('unknown');
      throw new MicrophoneError(
        error instanceof Error ? error.message : 'Could not open the microphone.',
        'unknown',
      );
    }
  }

  /** Permission can be revoked mid-session; say so rather than going quiet. */
  async #watchPermission(onChange?: (permission: MicPermission) => void): Promise<void> {
    if (onChange === undefined || navigator.permissions === undefined) return;
    try {
      const status = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      status.onchange = () => {
        onChange(status.state === 'prompt' ? 'unknown' : (status.state as MicPermission));
      };
    } catch {
      // Firefox and Safari do not expose the microphone permission here. Not fatal:
      // a revocation still surfaces as the capture stream ending.
    }
  }
}
