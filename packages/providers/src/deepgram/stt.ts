import type { AudioChunk, AudioStream, STT } from '@voice/core';
import { AsyncQueue } from '@voice/core';
import WebSocket from 'ws';

export interface DeepgramSttOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly language?: string;
  /**
   * Silence before Deepgram marks a segment `speech_final`, in ms.
   *
   * This is the number that decides whether the assistant interrupts you. It was
   * 200ms, which is shorter than an ordinary pause for breath — so the assistant
   * answered the first half of sentences. Deepgram's own guidance is that
   * `speech_final` operates at "tens to hundreds of milliseconds", which is a
   * *segment* boundary, not a *turn* boundary. A conversational value is most of
   * a second.
   */
  readonly endpointingMs?: number;
  /**
   * Window for `UtteranceEnd`, in ms. Deepgram documents 1000 as the floor.
   *
   * `UtteranceEnd` is derived from word timings rather than raw silence, which is
   * why it survives background noise that keeps the voice detector busy and stops
   * `speech_final` ever firing. It is the backstop, not the primary.
   */
  readonly utteranceEndMs?: number;
}

interface DeepgramMessage {
  readonly type?: string;
  readonly is_final?: boolean;
  readonly speech_final?: boolean;
  readonly channel?: { readonly alternatives?: ReadonlyArray<{ readonly transcript?: string }> };
}

/**
 * Deepgram Nova-3 behind the {@link STT} interface.
 *
 * End of turn follows Deepgram's documented pattern, which needs both signals:
 *
 *   1. a transcript with `speech_final: true`, **or**
 *   2. an `UtteranceEnd` message with no `speech_final` since the last utterance.
 *
 * Using only the first is unreliable, and specifically so: `speech_final` comes
 * from a voice activity detector, and background noise keeps that detector busy,
 * so in a noisy room it may never fire at all. `UtteranceEnd` is computed from
 * word end-times instead, so it survives noise. Handling one and ignoring the
 * other leaves a turn that never ends, or one that ends too early.
 *
 * **`final` means `speech_final`, never `is_final`.** Deepgram uses two words for
 * two claims: `is_final` says "this text is stable, I will not revise it", which
 * is true many times mid-sentence; `speech_final` says "the speaker stopped".
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
    // Tracks whether the voice detector already closed this utterance. If it did,
    // the UtteranceEnd that follows is redundant and must not end a second turn.
    let closedBySpeechFinal = false;

    const endTurn = (text: string): void => {
      const utterance = text.trim();
      committed = '';
      closedBySpeechFinal = true;
      if (utterance !== '') results.push({ text: utterance, final: true });
    };

    socket.on('message', (data: Buffer) => {
      let parsed: DeepgramMessage;
      try {
        parsed = JSON.parse(data.toString()) as DeepgramMessage;
      } catch {
        return;
      }

      // The noise-proof backstop. Only acts when the detector did not already
      // close the utterance — otherwise a quiet room would end every turn twice.
      if (parsed.type === 'UtteranceEnd') {
        if (!closedBySpeechFinal) endTurn(committed);
        return;
      }

      if (parsed.type !== 'Results') return;

      const transcript = parsed.channel?.alternatives?.[0]?.transcript ?? '';
      if (transcript === '' && parsed.speech_final !== true) return;

      if (parsed.speech_final === true) {
        endTurn(join(committed, transcript));
        return;
      }

      // Any real transcript means the speaker is going again, so the next
      // UtteranceEnd is once more meaningful.
      if (transcript !== '') closedBySpeechFinal = false;

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

  /** Exposed so the end-of-turn parameters can be asserted without a socket. */
  listenUrl(sampleRate: number): string {
    return this.#url(sampleRate);
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
      // 800ms, not 200. This single number decides whether the assistant lets you
      // finish a sentence; a pause for breath is routinely longer than 200ms.
      endpointing: String(this.#options.endpointingMs ?? 800),
      // Deepgram documents 1000 as the floor for this window.
      utterance_end_ms: String(this.#options.utteranceEndMs ?? 1200),
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
