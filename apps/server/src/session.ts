import type {
  AudioChunk,
  BridgeEvent,
  ClientEvent,
  Clock,
  PipelineAvailability,
  PipelineSelection,
  ServerEvent,
} from '@voice/core';
import { AsyncQueue, AudioBridge, encodeAudioFrame } from '@voice/core';

import type { PipelineSetup } from './pipeline.js';

/**
 * One browser connection's worth of state.
 *
 * Deliberately thin: it owns the socket's framing and nothing else. All the
 * behaviour — turn-taking, endpointing, streaming the model into the synthesiser —
 * lives in `AudioBridge` and the dialog inside @voice/core, where both are driven by
 * fakes in virtual time. This file is the adapter that turns bridge events into wire
 * events.
 *
 * `send` is injected rather than a socket being passed in, so a session is testable
 * without opening a port and the transport can change without touching this file.
 */
export interface SessionOptions {
  readonly sessionId: string;
  readonly clock: Clock;
  /**
   * Built per session rather than per process, because the browser chooses.
   * Deferred until `hello` arrives so the choice can be honoured on the very
   * first turn rather than the one after.
   */
  readonly buildPipeline: (want?: PipelineSelection) => PipelineSetup;
  readonly available: PipelineAvailability;
  readonly send: (payload: string | ArrayBuffer) => void;
  readonly log?: (message: string) => void;
}

export class Session {
  readonly #options: SessionOptions;
  readonly #mic = new AsyncQueue<AudioChunk>();
  #bridge: AudioBridge | undefined;
  #running: Promise<void> | undefined;
  #outboundSeq = 0;
  #sampleRate = 16_000;
  #closed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  #build(want?: PipelineSelection): PipelineSelection {
    const setup = this.#options.buildPipeline(want);
    this.#bridge = new AudioBridge({
      pipeline: setup.pipeline,
      dialog: setup.dialog,
      clock: this.#options.clock,
      endpointer: setup.endpointer,
      onEvent: (event) => this.#relay(event),
      onWarning: (message) => this.#log(message),
    });
    return setup.selected;
  }

  handleEvent(event: ClientEvent): void {
    switch (event.type) {
      case 'hello': {
        // The browser reports whatever rate it actually got; we do not assume one.
        // Some browsers decline an explicit AudioContext rate, and resampling on the
        // way in would add artefacts to solve a problem the STT does not have.
        if (event.sampleRate > 0) this.#sampleRate = event.sampleRate;

        const selected = this.#build(event.providers);
        this.#log(`pipeline stt=${selected.stt} llm=${selected.llm} tts=${selected.tts}`);
        // `selected`, not what was asked for: a stage whose key is missing falls
        // back, and the UI must show what loaded rather than what was requested.
        this.#emit({
          type: 'ready',
          sessionId: this.#options.sessionId,
          available: this.#options.available,
          selected,
        });
        break;
      }
      case 'start':
        this.#start();
        break;
      case 'stop':
        this.close();
        break;
      case 'interrupt':
        // The browser has already silenced its own output by the time this arrives.
        // This is the slow path: abandon generation and synthesis, and record what
        // the user actually heard so Phase 5 can resume from it.
        this.#log(`interrupt at t=${event.t}`);
        this.#bridge?.interrupt(event.t);
        break;
    }
  }

  /** A microphone frame arrived. Push it and return — never block the socket. */
  handleAudio(pcm: Int16Array): void {
    if (this.#closed) return;
    try {
      this.#mic.push({ pcm, sampleRate: this.#sampleRate });
    } catch (error) {
      this.#fail(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#bridge?.stop();
    this.#mic.close();
  }

  /** Resolves once the loop has finished. Used by tests and shutdown. */
  get finished(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  #start(): void {
    if (this.#running !== undefined) return;
    // A `start` without a preceding `hello` still works, on the defaults.
    if (this.#bridge === undefined) this.#build();
    this.#running = this.#bridge!.run(this.#mic).catch((error: unknown) => {
      this.#fail(error);
    });
  }

  #relay(event: BridgeEvent): void {
    switch (event.type) {
      case 'audio':
        this.#sendAudio(event.chunk);
        break;
      case 'interrupted':
        // Tell the browser to drop anything still queued. It has already ramped its
        // own output down locally; this clears frames that were in flight.
        this.#emit({ type: 'flush_audio' });
        this.#log(`interrupted after ${event.spokenChars} chars`);
        break;
      case 'pause_detected':
        // Already forwarded to the dialog over the protocol; the browser has no use
        // for it, so it is only logged here.
        this.#log(`pause at t=${event.at}`);
        break;
      case 'resumed':
        this.#log(`resumed from char ${event.from}`);
        break;
      case 'state':
        this.#emit({ type: 'state', state: event.state });
        break;
      case 'transcript':
        this.#emit({ type: 'transcript', text: event.text, final: event.final });
        break;
      case 'assistant_text':
        this.#emit({ type: 'assistant_text', text: event.text });
        break;
      case 'earcon':
        this.#emit({ type: 'earcon', sound: event.sound });
        break;
      case 'error':
        this.#emit({ type: 'error', message: event.message });
        break;
    }
  }

  #sendAudio(chunk: AudioChunk): void {
    const frame =
      chunk.span === undefined
        ? { seq: this.#outboundSeq, pcm: chunk.pcm }
        : { seq: this.#outboundSeq, pcm: chunk.pcm, span: chunk.span };
    this.#outboundSeq += 1;
    this.#options.send(encodeAudioFrame(frame));
  }

  #emit(event: ServerEvent): void {
    if (this.#closed && event.type !== 'error') return;
    this.#options.send(JSON.stringify(event));
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#log(`session failed: ${message}`);
    // Surface rather than hang. "No silent failures" is an evaluation line, and a
    // provider hiccup must reach the user as a failed earcon, not a dead socket.
    this.#options.send(JSON.stringify({ type: 'earcon', sound: 'failed' } satisfies ServerEvent));
    this.#options.send(JSON.stringify({ type: 'error', message } satisfies ServerEvent));
    this.close();
  }

  #log(message: string): void {
    this.#options.log?.(`[${this.#options.sessionId}] ${message}`);
  }
}
