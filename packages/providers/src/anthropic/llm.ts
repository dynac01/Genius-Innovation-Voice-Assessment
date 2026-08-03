import Anthropic from '@anthropic-ai/sdk';
import type { LLM, Message } from '@voice/core';

export interface AnthropicLlmOptions {
  readonly apiKey: string;
  /** Defaults to Haiku 4.5 — see the note on model choice below. */
  readonly model?: string;
  readonly systemPrompt?: string;
  /**
   * Hard ceiling on reply length.
   *
   * Deliberately small. A spoken reply is one to three sentences; anything longer
   * is a monologue the user will interrupt anyway, and every extra token is time
   * the assistant spends talking instead of listening.
   */
  readonly maxTokens?: number;
}

/**
 * A voice assistant answers out loud, so the prompt asks for speech, not prose.
 * Markdown, bullet lists, and headings are meaningless to a synthesiser — worse
 * than meaningless, since it reads the asterisks.
 */
const DEFAULT_SYSTEM_PROMPT = [
  'You are a voice assistant. Your replies are spoken aloud, never displayed.',
  'Answer in one to three short sentences. Be direct and conversational.',
  'Never use markdown, bullet points, headings, emoji, or code blocks — they are read aloud as punctuation.',
  'Write numbers, dates, and units the way a person would say them.',
  'If a question is ambiguous, ask one short clarifying question rather than guessing at length.',
].join(' ');

/**
 * Claude behind the {@link LLM} interface.
 *
 * Haiku 4.5 by default, and that is a latency decision rather than a cost one:
 * in a voice loop, time-to-first-token *is* the product. The user hears silence
 * until the first clause reaches the synthesiser, so the fastest tier wins on the
 * axis that matters. Set `model` to a larger Claude if replies feel thin — the
 * interface does not change.
 *
 * Thinking is left off. Haiku 4.5 does not think unless asked, which is what we
 * want here: deliberation before speaking is exactly the wrong trade for a
 * conversation. (`effort` is not set either — Haiku 4.5 rejects it.)
 */
export class AnthropicLlm implements LLM {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #systemPrompt: string;
  readonly #maxTokens: number;

  constructor(options: AnthropicLlmOptions) {
    this.#client = new Anthropic({ apiKey: options.apiKey });
    this.#model = options.model ?? 'claude-haiku-4-5';
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#maxTokens = options.maxTokens ?? 300;
  }

  async *respond(messages: Message[]): AsyncIterable<{ text: string }> {
    // The Messages API takes the system prompt as its own parameter rather than a
    // turn, so anything the loop recorded as `system` is lifted out here.
    const system = [
      this.#systemPrompt,
      ...messages.filter((m) => m.role === 'system').map((m) => m.content),
    ]
      .filter((text) => text !== '')
      .join('\n\n');

    const turns = messages
      .filter((m): m is Message & { role: 'user' | 'assistant' } => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    if (turns.length === 0) return;

    // Barge-in has to reach the provider, not just the speaker. Without this, an
    // abandoned reply keeps generating — and keeps billing — for tokens nobody
    // will ever hear.
    const controller = new AbortController();

    try {
      const stream = this.#client.messages.stream(
        {
          model: this.#model,
          max_tokens: this.#maxTokens,
          system,
          messages: turns,
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type !== 'text_delta') continue;
        yield { text: event.delta.text };
      }
    } finally {
      // Runs when the consumer breaks out of the loop — which is precisely what a
      // barge-in does. Aborting here is how "stop talking" becomes "stop thinking".
      controller.abort();
    }
  }
}
