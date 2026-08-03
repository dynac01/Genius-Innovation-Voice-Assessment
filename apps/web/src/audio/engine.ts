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

import { DEFAULT_VAD, StartRace, Vad, claimFrom } from '@voice/core';
import type { EarconSound } from '@voice/core';

import { EarconPlayer } from './earcons.js';

/**
 * Capture frame duration. Small frames keep the barge-in stop granular; the
 * sample count is derived from the context's actual rate so this stays constant
 * whatever hardware we land on.
 */
const CAPTURE_FRAME_MS = 20;

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
  /**
   * Diagnostic sink.
   *
   * The engine is the one layer whose failures are inaudible *and* invisible — a
   * context the device refused, a gain node stuck at zero, buffers scheduled into
   * the past. None of it throws. This is how it says what it did.
   */
  onLog?: (kind: string, data?: unknown) => void;
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
  readonly #race = new StartRace();
  #assistantActive = false;
  #earcons: EarconPlayer | undefined;
  #meter: AnalyserNode | undefined;
  #log: ((kind: string, data?: unknown) => void) | undefined;
  #playCount = 0;
  #wasSpeaking = false;
  #meterFrame: Float32Array<ArrayBuffer> | undefined;
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

  /**
   * True while assistant audio is scheduled at or ahead of the playhead.
   *
   * Includes audio that has been queued but has not started yet, which is what the
   * echo guard wants: by the time the speaker is producing sound it is too late to
   * start being careful about hearing it.
   */
  get outputActive(): boolean {
    return this.bufferedAheadMs > 0;
  }

  /**
   * True only while sound is genuinely coming out of the speaker.
   *
   * Not the same question as {@link outputActive}, and conflating them cost a real
   * failure. Audio is scheduled a jitter buffer ahead of the playhead, so for the
   * first 120ms of every reply there is audio *queued* and absolute silence in the
   * room. Treating that window as "the assistant is speaking" hands it to the
   * barge-in rule that yields instantly and without confirmation — and that rule is
   * only justified when there is sound to talk over, because its whole premise is
   * that a late stop is the failure everyone hears.
   *
   * The consequence when the premise is false is severe and self-sustaining: a user
   * whose detector is latched — still trailing off, or a room the threshold reads as
   * speech — kills every reply in the millisecond it is queued, before a sample
   * exists. The transcript fills in, the reply is abandoned after one character, and
   * nothing is ever heard. That is not a hypothetical; it is what a session log
   * showed, twice in one conversation.
   *
   * So the queued-but-silent window counts as *thinking*, where the assistant has
   * claimed the turn but produced no sound, and the rule there already requires
   * speech to sustain itself before a reply is thrown away.
   */
  get outputAudible(): boolean {
    const context = this.#context;
    if (context === undefined) return false;
    const now = context.currentTime;
    return this.#scheduled.some((entry) => entry.startedAt <= now && entry.endsAt > now);
  }

  /**
   * The assistant has claimed the turn — it is thinking or speaking.
   *
   * Distinct from {@link outputActive}, and the distinction is the whole point.
   * Waiting for audio means that speaking over the assistant *while it is still
   * composing* does nothing at all: there is no audio scheduled, so nothing looks
   * contended, and the reply arrives a second later as if you had never spoken.
   * A turn is claimed the moment the assistant starts working on it.
   */
  setAssistantActive(active: boolean): void {
    this.#assistantActive = active;
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
    this.#log = handlers.onLog;

    const stream = await this.#requestMicrophone(handlers.onPermissionChange);

    /*
     * The context runs at the hardware's own rate — deliberately not forced.
     *
     * One AudioContext serves both capture and playback here, so a rate chosen to
     * suit the microphone is also imposed on the speaker. Asking for 16kHz makes
     * the capture side tidy and asks the output device to run at a rate it may
     * not support; the failure is not an exception but silence, which is the
     * worst way for it to fail. Playback is the side with a user attached to it,
     * so it gets the native rate, and the capture side sends whatever it got and
     * says so in `hello`. The server never assumed a rate anyway.
     */
    const context = new AudioContext({ latencyHint: 'interactive' });
    if (context.state === 'suspended') await context.resume();

    await context.audioWorklet.addModule('/worklets/capture-processor.js');

    // Frame size follows the rate we were given, so frame *duration* — which is
    // what the detectors are tuned against — stays put across devices.
    const frameSamples = Math.round((CAPTURE_FRAME_MS / 1000) * context.sampleRate);
    const frameMs = (frameSamples / context.sampleRate) * 1000;

    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { frameSamples },
    });
    capture.port.onmessage = (event: MessageEvent<{ pcm: Int16Array; capturedAt: number }>) => {
      const { pcm, capturedAt } = event.data;

      /*
       * Run the detector before forwarding. Barge-in is decided here, in the
       * browser, because the round trip alone would exhaust the latency budget.
       *
       * Three questions, and each wants a different answer to "is the assistant
       * speaking":
       *
       * - The **echo guard** wants `scheduled`. It must already be cautious by the
       *   time sound arrives, so it counts audio that is merely queued.
       * - The **turn race** wants `audible`. It decides whether to throw a reply
       *   away, and the rule that yields instantly is only justified when there is
       *   sound to talk over.
       * - Everything queued but not yet playing is **thinking**: the turn is
       *   claimed, the room is silent, and speech must sustain itself before the
       *   reply is abandoned.
       *
       * Using one flag for all three is what let a latched detector destroy every
       * reply in the millisecond it was queued.
       */
      const scheduled = this.outputActive;
      const claim = claimFrom({
        scheduled,
        playing: this.outputAudible,
        composing: this.#assistantActive,
      });
      const audible = claim.audible;
      this.#vad.setOutputActive(scheduled);
      this.#vad.process(pcm, frameMs);

      if (this.#vad.speaking !== this.#wasSpeaking) {
        this.#wasSpeaking = this.#vad.speaking;
        // Logged because "was the user actually talking?" is the question every
        // disputed barge-in turns on, and it is unanswerable after the fact.
        this.#log?.('vad.speaking', {
          speaking: this.#vad.speaking,
          assistantScheduled: scheduled,
          assistantAudible: audible,
          assistantActive: this.#assistantActive,
        });
      }

      // Contention is a level, not an edge. Watching only for a rising edge on
      // user speech catches the assistant-first ordering and silently misses the
      // other one: a user who was already mid-sentence when the assistant started
      // produces no edge, so the assistant would talk straight over them. See
      // StartRace in @voice/core.
      const contest = this.#race.observe({
        assistantAudible: claim.audible,
        assistantThinking: claim.thinking,
        userSpeaking: this.#vad.speaking,
        frameMs,
      });

      if (contest === 'yield') {
        this.#log?.('audio.yield', { audible, scheduled, thinking: this.#assistantActive });
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

    /*
     * A meter on the speech output, tapped after the barge-in gain.
     *
     * This is a diagnostic, and it earns its place: everything upstream of the
     * speaker already reports itself — frames arrive, spans decode, the transcript
     * fills in — so when the assistant is inaudible, every indicator in the app is
     * green and the only remaining suspects are outside it. Silence has too many
     * causes to guess between: a muted output, a context the device would not run,
     * a disconnected node, a system volume, the wrong output device.
     *
     * Reading the samples that actually reach the destination splits that in one
     * glance. Moving meter and no sound is the machine's problem; still meter is
     * ours. It is also the honest version of the barge-in claim — the level visibly
     * drops to nothing the instant you speak.
     */
    const meter = context.createAnalyser();
    meter.fftSize = 1024;
    meter.smoothingTimeConstant = 0;
    output.connect(meter);

    source.connect(capture);
    capture.connect(sink);
    sink.connect(context.destination);

    this.#earcons = new EarconPlayer(context);

    this.#context = context;
    this.#stream = stream;
    this.#capture = capture;
    this.#sink = sink;
    this.#output = output;
    this.#meter = meter;
    this.#meterFrame = new Float32Array(meter.fftSize);
    this.#nextStartAt = 0;
  }

  /**
   * Everything about the audio stack that a fault report needs.
   *
   * Assembled in one place because these fields are only meaningful together: a
   * context rate on its own says nothing, but a context rate next to the rate the
   * frames are encoded at is the entire diagnosis of a session that transcribes to
   * nothing. `outputLatency` is included because a device reporting an implausible
   * figure is a good early sign that the browser and the hardware disagree.
   */
  describe(): Record<string, unknown> {
    const context = this.#context;
    if (context === undefined) return { started: false };
    return {
      started: true,
      sampleRate: context.sampleRate,
      state: context.state,
      baseLatencyMs: Math.round((context.baseLatency ?? 0) * 1000),
      outputLatencyMs: Math.round((context.outputLatency ?? 0) * 1000),
      destinationChannels: context.destination.channelCount,
      captureFrameMs: CAPTURE_FRAME_MS,
      jitterBufferMs: JITTER_BUFFER_MS,
      stopRampMs: STOP_RAMP_MS,
      outputGain: this.#output?.gain.value,
    };
  }

  /**
   * Peak amplitude currently reaching the speaker, 0–1.
   *
   * Sampled on demand rather than pushed, so a UI that stops looking costs nothing.
   */
  get outputLevel(): number {
    const meter = this.#meter;
    const frame = this.#meterFrame;
    if (meter === undefined || frame === undefined) return 0;
    meter.getFloatTimeDomainData(frame);
    let peak = 0;
    for (const sample of frame) peak = Math.max(peak, Math.abs(sample));
    return peak;
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

    /*
     * Re-assert audibility at the head of every run of audio.
     *
     * `flush()` drives this same gain to zero and schedules its own restore, so the
     * two are writing to one param from different events. Automation is easy to get
     * subtly wrong there — a cancel that lands between a ramp and its restore leaves
     * the node at zero — and the failure mode is the worst one available: every
     * later reply is synthesised, delivered, scheduled, and inaudible, with a full
     * transcript on screen insisting it worked.
     *
     * So flush's restore is treated as an optimisation rather than a guarantee. This
     * makes it structural: whatever automation ran before, the first frame after a
     * gap is preceded by an unconditional gain of 1. `startAt` is at least a jitter
     * buffer ahead of now, so this can never unmute audio a flush is still stopping.
     */
    if (this.#scheduled.length === 0) {
      output.gain.cancelScheduledValues(startAt);
      output.gain.setValueAtTime(1, startAt);
    }

    source.start(startAt);

    // The first frame of a run dates the moment sound was actually scheduled, and
    // carries the gain — which is the field that distinguishes "nothing was
    // scheduled" from "everything was scheduled into a muted node".
    if (this.#playCount === 0 || this.#playCount % 50 === 0) {
      this.#log?.('audio.play', {
        n: this.#playCount,
        samples: pcm.length,
        frameRate: sampleRate,
        contextRate: context.sampleRate,
        startInMs: Math.round((startAt - context.currentTime) * 1000),
        queued: this.#scheduled.length,
        gain: Math.round(output.gain.value * 1000) / 1000,
        contextState: context.state,
      });
    }
    this.#playCount += 1;

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
    const gainBefore = output.gain.value;
    const stoppedCount = this.#scheduled.length;

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

    this.#log?.('audio.flush', {
      stopped: stoppedCount,
      rampMs: STOP_RAMP_MS,
      gainBefore: Math.round(gainBefore * 1000) / 1000,
    });

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
    this.#meter?.disconnect();
    this.#earcons?.disconnect();
    this.#race.reset();
    this.#assistantActive = false;
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
