import type { AudioChunk, AudioStream, STT } from '@voice/core';
import { AsyncQueue } from '@voice/core';
import WebSocket from 'ws';

export interface DeepgramSttOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly language?: string;
  /**
   * Silence Deepgram waits for before finalising a segment, in ms.
   *
   * Kept low. Our own endpointer owns the end-of-turn decision and is tuned
   * against it; a provider that also waits a long time would stack its delay on
   * top of ours and make the assistant feel sluggish for reasons invisible in our
   * own configuration.
   */
  readonly endpointingMs?: number;
  /** How long after speech stops Deepgram emits `UtteranceEnd`. */
  readonly utteranceEndMs?: number;
}

interface DeepgramResult {
  readonly type?: string;
  readonly is_final?: boolean;
  readonly speech_final?: boolean;
  readonly channel?: { readonly alternatives?: ReadonlyArray<{ readonly transcript?: string }> };
}

/**
 * Deepgram Nova-3 behind the {@link STT} interface.
 *
 * One mapping decision matters more than the rest of this file:
 *
 * **`final` means `speech_final`, not `is_final`.** Deepgram uses two different
 * words for two different claims. `is_final` says "this text is stable, I will not
 * revise it" — which is true many times mid-sentence. `speech_final` says "the
 * speaker stopped." Wiring `final` to `is_final` would end the turn on the first
 * stable clause and cut the user off mid-thought, which is exactly the failure
 * criterion 4 exists to catch. The endpointer's `trustSttFinal` option assumes the
 * stronger claim, so this is where that assumption gets honoured.
 *
 * Deepgram also emits per-segment transcripts rather than a running utterance, so
 * finalised segments are accumulated here and interim text is appended to them —
 * otherwise the transcript would appear to reset every few words.
 */
export class DeepgramStt implements STT {
  readonly #options: DeepgramSttOptions;

  constructor(options: DeepgramSttOptions) {
    this.#options = options;
  }

  async *transcribeStream(audio: AudioStream): AsyncIterable<{ text: string; final: boolean }> {
    const iterator = audio[Symbol.asyncIterator]();

    // The socket URL carries the sample rate, and only the first frame knows it —
    // the browser reports whatever rate it actually got rather than a rate we
    // assumed. So the first chunk is read before connecting, then replayed.
    const first = await iterator.next();
    if (first.done === true) return;
    const firstChunk: AudioChunk = first.value;

    const socket = new WebSocket(this.#url(firstChunk.sampleRate), {
      headers: { Authorization: `Token ${this.#options.apiKey}` },
    });
    socket.binaryType = 'arraybuffer';

    const results = new AsyncQueue<{ text: string; final: boolean }>();
    let committed = '';

    socket.on('message', (data: Buffer) => {
      let parsed: DeepgramResult;
      try {
        parsed = JSON.parse(data.toString()) as DeepgramResult;
      } catch {
        return;
      }
      if (parsed.type !== 'Results') return;

      const transcript = parsed.channel?.alternatives?.[0]?.transcript ?? '';
      if (transcript === '' && parsed.speech_final !== true) return;

      if (parsed.speech_final === true) {
        const utterance = join(committed, transcript);
        committed = '';
        if (utterance !== '') results.push({ text: utterance, final: true });
        return;
      }

      if (parsed.is_final === true) {
        committed = join(committed, transcript);
        if (committed !== '') results.push({ text: committed, final: false });
        return;
      }

      // Interim: stable text so far plus the revisable tail.
      results.push({ text: join(committed, transcript), final: false });
    });

    socket.on('error', (error: Error) => results.fail(error));
    socket.on('close', () => results.close());

    const sending = (async () => {
      try {
        await once(socket, 'open');
        send(socket, firstChunk);
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break;
          send(socket, next.value);
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch (error) {
        results.fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    void sending.catch(() => undefined);

    try {
      yield* results;
    } finally {
      await iterator.return?.(undefined);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  }

  #url(sampleRate: number): string {
    const params = new URLSearchParams({
      model: this.#options.model ?? 'nova-3',
      language: this.#options.language ?? 'en-US',
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: '1',
      // Partials are what make the transcript update as the user speaks —
      // criterion 5's second half. Without them the transcript appears in one lump.
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: String(this.#options.endpointingMs ?? 200),
      utterance_end_ms: String(this.#options.utteranceEndMs ?? 1000),
      vad_events: 'true',
    });
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }
}

function join(committed: string, next: string): string {
  if (committed === '') return next;
  if (next === '') return committed;
  return `${committed} ${next}`;
}

function send(socket: WebSocket, chunk: AudioChunk): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(Buffer.from(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength), {
    binary: true,
  });
}

function once(socket: WebSocket, event: 'open'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.once(event, () => resolve());
    socket.once('error', reject);
  });
}
