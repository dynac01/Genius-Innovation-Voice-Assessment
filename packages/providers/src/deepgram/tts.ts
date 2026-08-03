import type { AudioChunk, TTS } from '@voice/core';
import { AsyncQueue } from '@voice/core';
import WebSocket from 'ws';
import type { RawData } from 'ws';

import { toInt16Samples } from '../ws-binary.js';
import type { BinaryMessage } from '../ws-binary.js';

export interface DeepgramTtsOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly sampleRate?: number;
  /**
   * Assumed speaking rate, used only to apportion character spans across audio
   * frames. See the note on spans below — this is an estimate, and the code is
   * written so that a wrong estimate degrades the resume point rather than
   * corrupting it.
   */
  readonly charsPerSecond?: number;
}

/** Aura-2 rejects a single message longer than this. */
const MAX_SPEAK_CHARS = 2000;

/**
 * Deepgram Aura-2 behind the {@link TTS} interface.
 *
 * The interesting part is the character spans. Criterion 2 resumes from the last
 * character the user *heard*, which needs a mapping from audio back to text —
 * and Aura-2 does not report one. Two options: emit no span, or estimate.
 *
 * Emitting nothing is the safe-looking choice and the worse one: the loop then
 * falls back to whole-clause granularity, so "keep going" after an interruption
 * mid-clause replays several words the user already heard. Estimating from a known
 * speaking rate lands within a word or two instead.
 *
 * The estimate is made safe rather than accurate:
 *   - spans only ever move forward, so an underestimate cannot rewind the resume point
 *   - spans are clamped to the text length, so an overestimate cannot run past the end
 *   - the final frame is pinned to the exact end, so a completed synthesis is exact
 *
 * A wrong rate therefore costs precision in the middle of a clause and nothing at
 * its boundaries. That is the right shape of failure for this: the alternative
 * loses the same precision unconditionally.
 */
export class DeepgramTts implements TTS {
  readonly #options: DeepgramTtsOptions;

  constructor(options: DeepgramTtsOptions) {
    this.#options = options;
  }

  async *synthesizeStream(text: string): AsyncIterable<AudioChunk> {
    const trimmed = text.trim();
    if (trimmed === '') return;

    const sampleRate = this.#options.sampleRate ?? 24_000;
    const charsPerSecond = this.#options.charsPerSecond ?? 15;
    const speakable = trimmed.slice(0, MAX_SPEAK_CHARS);

    const socket = new WebSocket(this.#url(sampleRate), {
      headers: { Authorization: `Token ${this.#options.apiKey}` },
    });
    socket.binaryType = 'arraybuffer';

    const frames = new AsyncQueue<Int16Array>();

    /*
     * `RawData`, not `Buffer`.
     *
     * The previous annotation here said `Buffer` and was simply wrong — `ws` hands
     * over an `ArrayBuffer` when `binaryType` is `'arraybuffer'`. An annotation is
     * an assertion rather than a check, so the compiler agreed, and the decoder
     * read `.buffer` and `.byteOffset` off a value that has neither. Both came back
     * `undefined`, `new Uint8Array(undefined, undefined, n)` produced an empty
     * array rather than throwing, and every frame arrived correctly sized, on time,
     * and completely silent. Taking the honest type is what makes the normaliser
     * mandatory instead of optional.
     */
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        frames.push(toInt16Samples(data as BinaryMessage));
        return;
      }
      try {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === 'Flushed') frames.close();
      } catch {
        /* metadata we do not need */
      }
    });

    socket.on('error', (error: Error) => frames.fail(error));
    socket.on('close', () => frames.close());

    const requesting = (async () => {
      try {
        await once(socket);
        socket.send(JSON.stringify({ type: 'Speak', text: speakable }));
        socket.send(JSON.stringify({ type: 'Flush' }));
      } catch (error) {
        frames.fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    void requesting.catch(() => undefined);

    const estimatedSamples = Math.max(
      1,
      Math.round((speakable.length / charsPerSecond) * sampleRate),
    );
    let emittedSamples = 0;
    let spanStart = 0;

    // One frame of lookahead, so the last frame can be pinned to the exact end of
    // the text. Without it an over-long rate estimate leaves the final span short
    // of the end — and the loop, which treats "spoken >= reply length" as the
    // signal that a reply finished, would wait for a completion that never comes.
    let pending: Int16Array | undefined;

    const frameWithSpan = (pcm: Int16Array, isLast: boolean): AudioChunk => {
      emittedSamples += pcm.length;
      const progress = Math.min(1, emittedSamples / estimatedSamples);
      const estimated = Math.round(progress * speakable.length);
      // Monotonic and clamped: never rewinds, never overruns. The last frame is
      // exact regardless of how wrong the estimate was.
      const spanEnd = isLast
        ? text.length
        : Math.max(spanStart, Math.min(speakable.length, estimated));
      const chunk: AudioChunk = { pcm, sampleRate, span: { start: spanStart, end: spanEnd } };
      spanStart = spanEnd;
      return chunk;
    };

    try {
      for await (const pcm of frames) {
        if (pcm.length === 0) continue;
        if (pending !== undefined) yield frameWithSpan(pending, false);
        pending = pcm;
      }
      if (pending !== undefined) yield frameWithSpan(pending, true);
    } finally {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  }

  #url(sampleRate: number): string {
    const params = new URLSearchParams({
      model: this.#options.model ?? 'aura-2-thalia-en',
      encoding: 'linear16',
      sample_rate: String(sampleRate),
    });
    return `wss://api.deepgram.com/v1/speak?${params.toString()}`;
  }
}

function once(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}
