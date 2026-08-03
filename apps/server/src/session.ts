import type { AudioChunk, ClientEvent, Pipeline, ServerEvent } from '@voice/core';
import { AsyncQueue, encodeAudioFrame } from '@voice/core';

/**
 * One browser connection's worth of state.
 *
 * Phase 2 deliberately: a straight-line pass-through, not the loop. Microphone
 * audio goes to STT, a final transcript goes to the model, the reply goes to TTS,
 * and the audio comes back. No turn state machine, no endpointing, no barge-in —
 * those are Phases 3 and 4. The job here is to prove bytes survive the round trip.
 *
 * `send` is injected rather than a socket being passed in, so the session is
 * testable without opening a port and the transport can be swapped without
 * touching this file.
 */
export interface SessionOptions {
  readonly sessionId: string;
  readonly pipeline: Pipeline;
  readonly send: (payload: string | ArrayBuffer) => void;
  readonly log?: (message: string) => void;
}

export class Session {
  readonly #options: SessionOptions;
  readonly #mic = new AsyncQueue<AudioChunk>();
  #running: Promise<void> | undefined;
  #outboundSeq = 0;
  #closed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  handleEvent(event: ClientEvent): void {
    switch (event.type) {
      case 'hello':
        this.#emit({ type: 'ready', sessionId: this.#options.sessionId });
        break;
      case 'start':
        this.#start();
        break;
      case 'stop':
        this.close();
        break;
      case 'interrupt':
        // Phase 4 acts on this. Recording it now keeps the wire contract honest:
        // the browser has already stopped its own audio locally by this point.
        this.#log(`interrupt at t=${event.t}`);
        break;
    }
  }

  /** A microphone frame arrived. Push it and return — never block the socket. */
  handleAudio(chunk: AudioChunk): void {
    if (this.#closed) return;
    try {
      this.#mic.push(chunk);
    } catch (error) {
      this.#fail(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#mic.close();
  }

  /** Resolves once the pipeline has finished. Used by tests and shutdown. */
  get finished(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  #start(): void {
    if (this.#running !== undefined) return;
    this.#emit({ type: 'state', state: 'listening' });
    this.#emit({ type: 'earcon', sound: 'listening' });
    this.#running = this.#run().catch((error: unknown) => {
      this.#fail(error);
    });
  }

  async #run(): Promise<void> {
    const { pipeline } = this.#options;

    let finalText = '';
    for await (const result of pipeline.stt.transcribeStream(this.#mic)) {
      this.#emit({ type: 'transcript', text: result.text, final: result.final });
      if (result.final) {
        finalText = result.text;
        break;
      }
    }
    if (this.#closed || finalText === '') return;

    this.#emit({ type: 'state', state: 'thinking' });
    this.#emit({ type: 'earcon', sound: 'accepted' });

    let reply = '';
    for await (const delta of pipeline.llm.respond([{ role: 'user', content: finalText }])) {
      reply += delta.text;
      this.#emit({ type: 'assistant_text', text: delta.text });
    }
    if (this.#closed) return;

    this.#emit({ type: 'state', state: 'speaking' });
    this.#emit({ type: 'earcon', sound: 'ready' });

    for await (const chunk of pipeline.tts.synthesizeStream(reply)) {
      if (this.#closed) return;
      this.#sendAudio(chunk);
    }

    this.#emit({ type: 'state', state: 'idle' });
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
    // provider hiccup must reach the user as a failed earcon, not as a dead socket.
    this.#options.send(JSON.stringify({ type: 'earcon', sound: 'failed' } satisfies ServerEvent));
    this.#options.send(JSON.stringify({ type: 'error', message } satisfies ServerEvent));
    this.close();
  }

  #log(message: string): void {
    this.#options.log?.(`[${this.#options.sessionId}] ${message}`);
  }
}
