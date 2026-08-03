import type { Clock, LLM, Message } from '@voice/core';

export interface CannedLlmOptions {
  readonly clock: Clock;
  /** The reply to stream. Emitted token-by-token, not all at once. */
  readonly reply: string;
  /** Time to first token — models the provider's think time. */
  readonly ttftMs?: number;
  /** Gap between tokens thereafter. */
  readonly interTokenMs?: number;
}

/** What one `respond` call was asked, and how far it got. */
export interface LlmCall {
  readonly messages: readonly Message[];
  tokensEmitted: number;
  textEmitted: string;
  /** False when the consumer stopped iterating early — an abandoned reply. */
  completed: boolean;
}

/** Split into word-ish tokens, keeping trailing whitespace so joins round-trip. */
function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/**
 * A model that streams a known reply at a controllable rate.
 *
 * Streaming token-by-token rather than returning the whole string is what makes
 * criterion 5 testable: "TTS begins speaking before the full reply is generated"
 * is only a meaningful assertion if there is a window during which the reply is
 * genuinely incomplete.
 *
 * `calls` records every invocation and whether it ran to completion, which is how a
 * test distinguishes a reply that finished from one abandoned mid-flight.
 */
export class CannedLlm implements LLM {
  readonly calls: LlmCall[] = [];

  readonly #clock: Clock;
  readonly #reply: string;
  readonly #ttftMs: number;
  readonly #interTokenMs: number;

  constructor(options: CannedLlmOptions) {
    this.#clock = options.clock;
    this.#reply = options.reply;
    this.#ttftMs = options.ttftMs ?? 120;
    this.#interTokenMs = options.interTokenMs ?? 20;
  }

  get lastCall(): LlmCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  async *respond(messages: Message[]): AsyncIterable<{ text: string }> {
    const call: LlmCall = {
      messages: [...messages],
      tokensEmitted: 0,
      textEmitted: '',
      completed: false,
    };
    this.calls.push(call);

    const tokens = tokenize(this.#reply);
    await this.#clock.sleep(this.#ttftMs);
    for (const [index, token] of tokens.entries()) {
      if (index > 0) await this.#clock.sleep(this.#interTokenMs);
      call.tokensEmitted += 1;
      call.textEmitted += token;
      yield { text: token };
    }

    // Only reached when the consumer iterated to the end. A consumer that breaks
    // early closes the generator here, leaving `completed` false — which is exactly
    // the signal an abandoned reply needs.
    call.completed = true;
  }
}
