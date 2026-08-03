/**
 * The voice loop.
 *
 * Written against the three pipeline interfaces and a `Clock`, and nothing else —
 * no socket, no audio device, no provider SDK. That is what makes it the reusable
 * core the brief asks for, and why the whole of its behaviour can be driven by fakes
 * in virtual time.
 *
 * Two properties are worth stating up front because they are easy to lose:
 *
 * 1. **The model and the synthesiser run concurrently.** Text is handed to TTS the
 *    moment a speakable chunk exists, while the model is still generating the rest.
 *    Serialising them would be simpler and would cost most of a second of silence
 *    on every turn.
 * 2. **The loop schedules nothing it does not need.** End-of-turn detection arms a
 *    single timer at the endpointer's next deadline rather than polling, so an idle
 *    session does no work — and a test can run the whole conversation to completion
 *    without a wall-clock tick.
 */

import type { AudioChunk, AudioStream } from './audio.js';
import { AsyncQueue } from './async-queue.js';
import type { ChunkerConfig } from './chunker.js';
import { ClauseChunker } from './chunker.js';
import type { Clock } from './clock.js';
import type { EndpointerConfig } from './endpointer.js';
import { Endpointer } from './endpointer.js';
import type { Message } from './messages.js';
import type { Pipeline } from './pipeline.js';
import type { EarconSound } from './protocol.js';
import type { TurnEvent, TurnState } from './turn.js';
import { TurnMachine, accepts } from './turn.js';

export type LoopEvent =
  | { type: 'state'; state: TurnState }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'assistant_text'; text: string }
  | { type: 'audio'; chunk: AudioChunk }
  | { type: 'earcon'; sound: EarconSound }
  | { type: 'pause_detected'; at: number }
  | { type: 'interrupted'; at: number; reply: string; spokenChars: number }
  | { type: 'error'; message: string };

/**
 * What the user actually heard of a reply that was cut off.
 *
 * `spokenChars` indexes into `reply` — everything before it reached the speaker,
 * everything after it did not. This is the resume point criterion 2 turns on, and
 * it is deliberately *not* the generation cursor: the model runs ahead of the
 * synthesiser, which runs ahead of the playhead, so where generation stopped and
 * where hearing stopped are different places.
 */
export interface InterruptedReply {
  readonly reply: string;
  readonly spokenChars: number;
}

export interface VoiceLoopOptions {
  readonly pipeline: Pipeline;
  readonly clock: Clock;
  readonly onEvent: (event: LoopEvent) => void;
  readonly endpointer?: Partial<EndpointerConfig>;
  readonly chunker?: Partial<ChunkerConfig>;
  readonly systemPrompt?: string;
  readonly onWarning?: (message: string) => void;
}

type LoopInput =
  { kind: 'transcript'; text: string; final: boolean; at: number } | { kind: 'tick'; at: number };

export class VoiceLoop {
  readonly #options: VoiceLoopOptions;
  readonly #turn = new TurnMachine();
  readonly #endpointer: Endpointer;
  readonly #history: Message[] = [];
  #timerGeneration = 0;
  #replyGeneration = 0;
  #replyText = '';
  #spokenChars = 0;
  #interrupted: InterruptedReply | undefined;
  #stopped = false;

  constructor(options: VoiceLoopOptions) {
    this.#options = options;
    this.#endpointer = new Endpointer(options.endpointer ?? {});
    if (options.systemPrompt !== undefined) {
      this.#history.push({ role: 'system', content: options.systemPrompt });
    }
  }

  get state(): TurnState {
    return this.#turn.state;
  }

  /** Conversation so far, excluding any system prompt. */
  get transcript(): readonly Message[] {
    return this.#history.filter((message) => message.role !== 'system');
  }

  /** What the user heard of the last reply that was cut off, if any. */
  get interrupted(): InterruptedReply | undefined {
    return this.#interrupted;
  }

  /**
   * The user started talking over the assistant.
   *
   * By the time this arrives the browser has already silenced its own output — the
   * round trip decides what the interruption *meant*, never whether to stop. What
   * happens here is the server-side half: abandon generation and synthesis, and
   * record how far the reply actually got.
   *
   * The generation counter is checked inside the chunk loop, so emission stops on
   * the next chunk rather than at the end of the current sentence. That distinction
   * is criterion 1, and it is the difference between a clean cut and a tail.
   */
  interrupt(at: number): void {
    if (!accepts(this.#turn.state, { type: 'interrupt' })) {
      this.#options.onWarning?.(`interrupt ignored while ${this.#turn.state}`);
      return;
    }
    this.#replyGeneration += 1;
    this.#interrupted = { reply: this.#replyText, spokenChars: this.#spokenChars };
    this.#emit({
      type: 'interrupted',
      at,
      reply: this.#replyText,
      spokenChars: this.#spokenChars,
    });
    this.#apply({ type: 'interrupt' });
  }

  /** Runs until the microphone stream ends or {@link stop} is called. */
  async run(mic: AudioStream): Promise<void> {
    this.#apply({ type: 'start' });

    const inputs = new AsyncQueue<LoopInput>();

    const transcribing = (async () => {
      try {
        for await (const result of this.#options.pipeline.stt.transcribeStream(mic)) {
          if (this.#stopped) break;
          inputs.push({
            kind: 'transcript',
            text: result.text,
            final: result.final,
            at: this.#options.clock.now(),
          });
        }
      } finally {
        inputs.close();
      }
    })();
    // The consumer below observes the failure; this only stops Node complaining
    // about a rejection that is handled a few lines later.
    void transcribing.catch(() => undefined);

    try {
      for await (const input of inputs) {
        if (this.#stopped) break;
        if (input.kind === 'transcript') {
          this.#emit({ type: 'transcript', text: input.text, final: input.final });
        }

        const outcome = this.#endpointer.observe(
          input.kind === 'transcript'
            ? { type: 'transcript', text: input.text, final: input.final, at: input.at }
            : { type: 'tick', at: input.at },
        );

        if (outcome.type === 'pause') {
          this.#emit({ type: 'pause_detected', at: outcome.at });
        } else if (outcome.type === 'endpoint') {
          await this.#respond(outcome.text);
          this.#endpointer.reset();
        }

        this.#arm(inputs);
      }
      await transcribing;
    } finally {
      this.#timerGeneration += 1;
      this.#apply({ type: 'stop' });
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#timerGeneration += 1;
  }

  /**
   * Arm a single timer for the endpointer's next deadline.
   *
   * The generation counter retires timers superseded by newer speech. Without it,
   * a stale wake-up from before the user resumed talking could end the turn they
   * are still in the middle of — the exact failure criterion 4 tests for.
   */
  #arm(inputs: AsyncQueue<LoopInput>): void {
    const wake = this.#endpointer.wakeAt;
    if (wake === undefined || this.#stopped) return;

    const generation = (this.#timerGeneration += 1);
    const delay = Math.max(0, wake - this.#options.clock.now());

    void (async () => {
      await this.#options.clock.sleep(delay);
      if (generation !== this.#timerGeneration || this.#stopped || inputs.closed) return;
      inputs.push({ kind: 'tick', at: this.#options.clock.now() });
    })();
  }

  async #respond(text: string): Promise<void> {
    if (text.trim() === '') return;

    this.#apply({ type: 'endpoint' });
    this.#emit({ type: 'earcon', sound: 'accepted' });
    this.#history.push({ role: 'user', content: text });

    const generation = (this.#replyGeneration += 1);
    this.#replyText = '';
    this.#spokenChars = 0;
    this.#interrupted = undefined;

    const speech = new AsyncQueue<string>();
    const chunker = new ClauseChunker(this.#options.chunker ?? {});

    // Started before the model is consumed, so synthesis of chunk one overlaps
    // generation of chunk two. This is criterion 5.
    const speaking = this.#speakAll(speech, generation);
    let speakingFailure: unknown;
    void speaking.catch((error: unknown) => {
      speakingFailure = error;
      speech.close();
    });

    try {
      for await (const delta of this.#options.pipeline.llm.respond([...this.#history])) {
        // An interruption abandons generation too, not just playback: continuing to
        // pay for tokens nobody will hear is the same mistake as a late stop.
        if (this.#stopped || speakingFailure !== undefined) break;
        if (generation !== this.#replyGeneration) break;
        this.#replyText += delta.text;
        this.#emit({ type: 'assistant_text', text: delta.text });
        for (const chunk of chunker.push(delta.text)) speech.push(chunk);
      }
      const tail = chunker.flush();
      if (
        tail !== undefined &&
        speakingFailure === undefined &&
        generation === this.#replyGeneration
      ) {
        speech.push(tail);
      }
    } catch (error) {
      speech.close();
      await speaking.catch(() => undefined);
      this.#fail(error);
      return;
    }

    speech.close();
    try {
      await speaking;
    } catch (error) {
      this.#fail(error);
      return;
    }

    // An interrupt already moved the machine back to listening and recorded what was
    // heard. Applying `reply_done` on top would be a second, illegal transition.
    if (generation !== this.#replyGeneration) return;

    if (this.#replyText !== '') {
      this.#history.push({ role: 'assistant', content: this.#replyText });
    }
    this.#apply({ type: 'reply_done' });
  }

  async #speakAll(speech: AsyncQueue<string>, generation: number): Promise<void> {
    for await (const text of speech) {
      if (this.#stopped || generation !== this.#replyGeneration) return;

      // Where this chunk sits in the reply. The chunker trims its seams, so the
      // offset is found rather than accumulated — accumulating would drift by
      // exactly the whitespace it removed, and drift is what makes a resume land
      // in the wrong place.
      const base = Math.max(0, this.#replyText.indexOf(text, this.#spokenChars));

      for await (const chunk of this.#options.pipeline.tts.synthesizeStream(text)) {
        // Checked here, inside the chunk loop, so emission stops on the *next
        // chunk* rather than at the end of the current sentence. Criterion 1.
        if (this.#stopped || generation !== this.#replyGeneration) return;

        if (this.#turn.state !== 'speaking') {
          this.#apply({ type: 'audio' });
          this.#emit({ type: 'earcon', sound: 'ready' });
        }
        this.#spokenChars = base + (chunk.span?.end ?? text.length);
        this.#emit({ type: 'audio', chunk });
      }
    }
  }

  /**
   * A provider hiccup surfaces as a failed earcon and returns the loop to
   * listening. Criterion 8 asks for exactly this rather than a hang, and it is why
   * the failure path emits before it transitions.
   */
  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#emit({ type: 'earcon', sound: 'failed' });
    this.#emit({ type: 'error', message });
    this.#apply({ type: 'reply_done' });
  }

  #apply(event: TurnEvent): void {
    const next = this.#turn.apply(event);
    if (next === undefined) {
      this.#options.onWarning?.(`rejected ${event.type} while ${this.#turn.state}`);
      return;
    }
    this.#emit({ type: 'state', state: next });
    if (event.type === 'start') this.#emit({ type: 'earcon', sound: 'listening' });
  }

  #emit(event: LoopEvent): void {
    this.#options.onEvent(event);
  }
}
