/**
 * The audio bridge.
 *
 * Owns everything acoustic: microphone in, transcription, end-of-turn detection,
 * synthesis, audio out, and the ability to go silent instantly. It owns no opinion
 * about *what to say* — that is the dialog's job, reached only over the fixed
 * protocol in protocol.ts.
 *
 * The split is load-bearing, not decorative. Because the model lives behind
 * `Dialog` rather than inside this file, a real decision engine replaces the stub
 * without this file changing, and every acoustic behaviour can be tested against a
 * dialog that says exactly what a test needs.
 *
 *   mic ─▶ STT ─▶ endpointer ─┐                    ┌─▶ TTS ─▶ audio out
 *                             ├─ FromBridge ─▶     │
 *                          bridge            dialog│
 *                             ◀── ToBridge ────────┘
 *
 * Pausing stops the voice, not the thinking. When a reply is paused the dialog keeps
 * generating and the bridge keeps accumulating the text — it simply does not speak
 * it. Resuming is then instant rather than paying generation latency a second time,
 * and the resume point is exact because the text was never discarded.
 */

import type { AudioChunk, AudioStream } from './audio.js';
import { AsyncQueue } from './async-queue.js';
import type { Clock } from './clock.js';
import type { EndpointerConfig } from './endpointer.js';
import { Endpointer } from './endpointer.js';
import type { Pipeline } from './pipeline.js';
import type { Dialog, EarconSound, FromBridge, ToBridge } from './protocol.js';
import type { TurnEvent, TurnState } from './turn.js';
import { TurnMachine, accepts } from './turn.js';

export type BridgeEvent =
  | { type: 'state'; state: TurnState }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'assistant_text'; text: string }
  | { type: 'audio'; chunk: AudioChunk }
  | { type: 'earcon'; sound: EarconSound }
  | { type: 'pause_detected'; at: number }
  | { type: 'interrupted'; at: number; reply: string; spokenChars: number }
  | { type: 'resumed'; from: number; remaining: string }
  | { type: 'error'; message: string };

export interface AudioBridgeOptions {
  readonly pipeline: Pipeline;
  readonly dialog: Dialog;
  readonly clock: Clock;
  readonly onEvent: (event: BridgeEvent) => void;
  readonly endpointer?: Partial<EndpointerConfig>;
  readonly onWarning?: (message: string) => void;
}

/** What the user heard of a reply that was cut off. */
export interface InterruptedReply {
  readonly reply: string;
  readonly spokenChars: number;
}

type BridgeInput =
  { kind: 'transcript'; text: string; final: boolean; at: number } | { kind: 'tick'; at: number };

/** Whether the bridge is currently willing to turn text into sound. */
type SpeechGate = 'open' | 'paused';

export class AudioBridge {
  readonly #options: AudioBridgeOptions;
  readonly #turn = new TurnMachine();
  readonly #endpointer: Endpointer;

  readonly #toDialog = new AsyncQueue<FromBridge>();
  readonly #speech = new AsyncQueue<string>();

  #gate: SpeechGate = 'open';
  #reply = '';
  #spokenChars = 0;
  #speakGeneration = 0;
  #timerGeneration = 0;
  #stopped = false;

  constructor(options: AudioBridgeOptions) {
    this.#options = options;
    this.#endpointer = new Endpointer(options.endpointer ?? {});
  }

  get state(): TurnState {
    return this.#turn.state;
  }

  /** The reply in flight, and how much of it has reached the speaker. */
  get inFlight(): InterruptedReply {
    return { reply: this.#reply, spokenChars: this.#spokenChars };
  }

  get paused(): boolean {
    return this.#gate === 'paused';
  }

  /**
   * The user began speaking over the assistant.
   *
   * The browser has already silenced its own output; this is the server-side half.
   * Output is gated **before** the dialog is consulted, because asking first would
   * spend the whole latency budget on a round trip. The dialog then decides what the
   * interruption meant, and answers with `barge_in`.
   */
  interrupt(at: number): void {
    if (!accepts(this.#turn.state, { type: 'interrupt' })) {
      this.#options.onWarning?.(`interrupt ignored while ${this.#turn.state}`);
      return;
    }
    this.#gateClosed();
    this.#emit({
      type: 'interrupted',
      at,
      reply: this.#reply,
      spokenChars: this.#spokenChars,
    });
    this.#apply({ type: 'interrupt' });
    this.#toDialog.push({ type: 'interrupt', t: at });
  }

  async run(mic: AudioStream): Promise<void> {
    this.#apply({ type: 'start' });

    const commands = this.#options.dialog.connect(this.#toDialog);
    const dialogTask = (async () => {
      for await (const command of commands) this.#onCommand(command);
    })();
    void dialogTask.catch((error: unknown) => this.#fail(error));

    const speaking = this.#speakLoop();
    void speaking.catch((error: unknown) => this.#fail(error));

    const inputs = new AsyncQueue<BridgeInput>();
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
    void transcribing.catch(() => undefined);

    try {
      for await (const input of inputs) {
        if (this.#stopped) break;
        if (input.kind === 'transcript') {
          this.#emit({ type: 'transcript', text: input.text, final: input.final });
        }
        this.#onEndpointer(input);
        this.#arm(inputs);
      }
      await transcribing;
    } finally {
      this.#timerGeneration += 1;
      this.#toDialog.close();
      this.#speech.close();
      await dialogTask.catch(() => undefined);
      await speaking.catch(() => undefined);
      this.#apply({ type: 'stop' });
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#timerGeneration += 1;
    this.#speakGeneration += 1;
    this.#toDialog.close();
    this.#speech.close();
  }

  // ── the dialog side ───────────────────────────────────────────────────────

  #onCommand(command: ToBridge): void {
    switch (command.type) {
      case 'say':
        this.#onSay(command.text);
        break;
      case 'earcon':
        this.#emit({ type: 'earcon', sound: command.sound });
        break;
      case 'barge_in':
        this.#onBargeIn(command.behavior);
        break;
    }
  }

  #onSay(text: string): void {
    if (text === '') return;
    const separator = this.#reply === '' || this.#reply.endsWith(' ') ? '' : ' ';
    this.#reply += separator + text;
    this.#emit({ type: 'assistant_text', text: separator + text });

    // While paused the text is still accumulated but not spoken. That is the whole
    // of "pausing stops the voice, not the thinking" — and it is what lets a resume
    // pick up exactly where hearing stopped rather than where generation did.
    if (this.#gate === 'open') this.#speech.push(text);
  }

  #onBargeIn(behavior: 'stop' | 'pause' | 'finish'): void {
    switch (behavior) {
      case 'pause':
        this.#gateClosed();
        break;

      case 'finish':
        this.#resume();
        break;

      case 'stop':
        this.#gateClosed();
        this.#reply = '';
        this.#spokenChars = 0;
        this.#gate = 'open';
        break;
    }
  }

  /** Silence output now and stop anything queued. Retains the reply and its offset. */
  #gateClosed(): void {
    this.#gate = 'paused';
    // Retires the in-flight synthesis on its next chunk — not at the end of the
    // current sentence. That distinction is criterion 1.
    this.#speakGeneration += 1;
  }

  #resume(): void {
    if (this.#gate === 'open') return; // already speaking; "finish" means let it run
    this.#gate = 'open';

    const remaining = this.#reply.slice(this.#spokenChars);
    if (remaining.trim() === '') {
      this.#apply({ type: 'reply_done' });
      return;
    }

    this.#apply({ type: 'resume' });
    this.#emit({ type: 'resumed', from: this.#spokenChars, remaining });
    this.#speech.push(remaining);
  }

  // ── the acoustic side ─────────────────────────────────────────────────────

  async #speakLoop(): Promise<void> {
    for await (const text of this.#speech) {
      if (this.#stopped) return;
      if (this.#gate !== 'open') continue;

      /*
       * A failed clause must not take the loop down with it.
       *
       * This is the only loop that speaks, and it runs for the whole session. An
       * error escaping here unwinds the `for await` permanently: the catch attached
       * to this method's promise still reports honestly — failed earcon, error
       * event, turn returned to a usable state — and by the time it runs there is
       * nothing left to speak with. Everything downstream keeps working, which is
       * what makes it so hard to see. Transcripts update, turns are taken, the
       * socket stays open, and the assistant is mute from then on.
       *
       * That is not hypothetical: a real session lost its voice exactly this way
       * when a synthesis socket went quiet and the idle budget fired.
       *
       * The failure the hiccup tests already covered was a *model* failure, which
       * happens upstream of here and therefore never exercised this. One is
       * recoverable and the other was terminal, and nothing distinguished them.
       *
       * So synthesis failures are per-clause: report, end the turn, keep the loop.
       * The outer catch stays for the case it is actually right for — the speech
       * queue itself failing, which nothing can recover from.
       */
      try {
        await this.#speakOne(text);
      } catch (error) {
        this.#fail(error);
      }
    }
  }

  /** One clause: synthesise it, emit its audio, and close the reply if it was the last. */
  async #speakOne(text: string): Promise<void> {
    const generation = this.#speakGeneration;

    // Where this text sits in the reply. Found rather than accumulated: the
    // chunker trims its seams, so accumulating would drift by exactly the
    // whitespace removed — and drift is what makes a resume land in the wrong place.
    const found = this.#reply.indexOf(text, Math.max(0, this.#spokenChars - 1));
    const base = found >= 0 ? found : this.#spokenChars;

    for await (const chunk of this.#options.pipeline.tts.synthesizeStream(text)) {
      if (this.#stopped || generation !== this.#speakGeneration) break;

      this.#ensureSpeaking();
      this.#spokenChars = base + (chunk.span?.end ?? text.length);
      this.#emit({ type: 'audio', chunk });
    }

    // Reply fully spoken with nothing queued behind it.
    if (
      generation === this.#speakGeneration &&
      this.#gate === 'open' &&
      this.#speech.size === 0 &&
      this.#spokenChars >= this.#reply.length &&
      this.#turn.state === 'speaking'
    ) {
      this.#apply({ type: 'reply_done' });
    }
  }

  /**
   * Get to `speaking`, from wherever we are.
   *
   * `say` commands arrive asynchronously, so the speech queue can drain a moment
   * before the dialog pushes its next clause — briefly returning the machine to
   * listening. A late clause must not then hit an illegal `audio` transition and be
   * dropped, so the path back is taken explicitly rather than assumed.
   */
  #ensureSpeaking(): void {
    if (this.#turn.state === 'speaking') return;
    if (this.#turn.state === 'listening') this.#apply({ type: 'resume' });
    if (this.#turn.state === 'thinking') this.#apply({ type: 'audio' });
  }

  #onEndpointer(input: BridgeInput): void {
    const outcome = this.#endpointer.observe(
      input.kind === 'transcript'
        ? { type: 'transcript', text: input.text, final: input.final, at: input.at }
        : { type: 'tick', at: input.at },
    );

    if (outcome.type === 'pause') {
      this.#emit({ type: 'pause_detected', at: outcome.at });
      this.#toDialog.push({ type: 'pause_detected', t: outcome.at });
      return;
    }
    if (outcome.type !== 'endpoint' || outcome.text.trim() === '') return;

    // A new utterance begins a turn only if one is not already running; when a reply
    // is paused, this utterance is the answer to the interruption, and the dialog
    // decides which it is.
    if (this.#turn.state === 'listening' && this.#gate === 'open') {
      this.#apply({ type: 'endpoint' });
    }
    this.#toDialog.push({ type: 'utterance', text: outcome.text, t: outcome.at });
    this.#endpointer.reset();
  }

  #arm(inputs: AsyncQueue<BridgeInput>): void {
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

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#emit({ type: 'earcon', sound: 'failed' });
    this.#emit({ type: 'error', message });
    if (accepts(this.#turn.state, { type: 'reply_done' })) {
      this.#apply({ type: 'reply_done' });
    }
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

  #emit(event: BridgeEvent): void {
    this.#options.onEvent(event);
  }
}
