/**
 * The stub dialog.
 *
 * Deliberately simple — the brief asks for "a simple stub dialog" because the point
 * is the *protocol*, not the intelligence behind it. What matters is that everything
 * a decision engine needs is expressible here: it owns the model, the conversation
 * history, and every judgement about what an interruption meant. The bridge owns
 * none of that and would not change if this class were replaced by something far
 * more capable.
 *
 * It emits `say` per clause rather than per reply, which is what keeps synthesis
 * overlapping generation — the assistant starts speaking before the model has
 * finished thinking.
 */

import type { ChunkerConfig } from './chunker.js';
import { ClauseChunker } from './chunker.js';
import { AsyncQueue } from './async-queue.js';
import { bargeInFor, classifyUtterance } from './intent.js';
import type { UtteranceIntent } from './intent.js';
import type { Message } from './messages.js';
import type { LLM } from './pipeline.js';
import type { Dialog, FromBridge, ToBridge } from './protocol.js';

export interface StubDialogOptions {
  readonly llm: LLM;
  readonly chunker?: Partial<ChunkerConfig>;
  readonly systemPrompt?: string;
  readonly onWarning?: (message: string) => void;
}

export class StubDialog implements Dialog {
  readonly #options: StubDialogOptions;
  readonly #history: Message[] = [];
  #awaitingInterruptReply = false;
  #generation = 0;

  constructor(options: StubDialogOptions) {
    this.#options = options;
    if (options.systemPrompt !== undefined) {
      this.#history.push({ role: 'system', content: options.systemPrompt });
    }
  }

  /** Conversation so far, excluding any system prompt. */
  get history(): readonly Message[] {
    return this.#history.filter((message) => message.role !== 'system');
  }

  /** How the last interruption was read. Exposed for tests and for the demo UI. */
  lastIntent: UtteranceIntent | undefined;

  async *connect(events: AsyncIterable<FromBridge>): AsyncIterable<ToBridge> {
    const out = new AsyncQueue<ToBridge>();

    // Events are consumed in a separate task so a reply in progress never blocks the
    // next event. An interrupt arriving mid-generation is the entire point of this
    // system; queueing it behind the reply it is interrupting would be absurd.
    const pump = (async () => {
      try {
        for await (const event of events) this.#onEvent(event, out);
      } finally {
        out.close();
      }
    })();
    void pump.catch(() => out.close());

    yield* out;
    await pump;
  }

  #onEvent(event: FromBridge, out: AsyncQueue<ToBridge>): void {
    switch (event.type) {
      case 'interrupt':
        // Park the reply rather than discarding it. Until the user's words arrive we
        // do not know whether this was "keep going", "hold on", or a new question —
        // and pausing is the only choice that keeps all three options open.
        this.#awaitingInterruptReply = true;
        out.push({ type: 'barge_in', behavior: 'pause' });
        break;

      case 'utterance':
        this.#onUtterance(event.text, out);
        break;

      case 'pause_detected':
        // A hesitation is information, not an instruction. A more capable engine
        // might use it to decide whether to prompt; the stub waits.
        break;
    }
  }

  #onUtterance(text: string, out: AsyncQueue<ToBridge>): void {
    if (this.#awaitingInterruptReply) {
      this.#awaitingInterruptReply = false;

      const intent = classifyUtterance(text);
      this.lastIntent = intent;
      out.push({ type: 'barge_in', behavior: bargeInFor(intent) });

      if (intent !== 'fresh') {
        // resume / backchannel resume the parked reply, pause holds it, cancel drops
        // it. None of them produce new words.
        if (intent === 'cancel') this.#generation += 1;
        return;
      }
      // A genuinely new request: the prior reply is abandoned above, and this
      // utterance drives the next one.
    }

    this.lastIntent = undefined;
    void this.#respond(text, out);
  }

  async #respond(text: string, out: AsyncQueue<ToBridge>): Promise<void> {
    const generation = (this.#generation += 1);
    this.#history.push({ role: 'user', content: text });
    out.push({ type: 'earcon', sound: 'accepted' });

    const chunker = new ClauseChunker(this.#options.chunker ?? {});
    let reply = '';
    let announced = false;

    try {
      for await (const delta of this.#options.llm.respond([...this.#history])) {
        if (generation !== this.#generation) return;
        reply += delta.text;
        for (const chunk of chunker.push(delta.text)) {
          if (!announced) {
            out.push({ type: 'earcon', sound: 'ready' });
            announced = true;
          }
          out.push({ type: 'say', text: chunk });
        }
      }

      const tail = chunker.flush();
      if (tail !== undefined && generation === this.#generation) {
        if (!announced) out.push({ type: 'earcon', sound: 'ready' });
        out.push({ type: 'say', text: tail });
      }

      if (reply !== '') this.#history.push({ role: 'assistant', content: reply });
    } catch (error) {
      // A provider hiccup surfaces as a failed earcon rather than a hang. The bridge
      // returns to listening; the user hears that something went wrong and can retry.
      this.#options.onWarning?.(error instanceof Error ? error.message : String(error));
      out.push({ type: 'earcon', sound: 'failed' });
      out.push({ type: 'barge_in', behavior: 'stop' });
    }
  }
}
