/**
 * Splits a streaming model reply into units worth speaking.
 *
 * Time-to-first-audio is dominated by one decision: how long you wait before handing
 * the first text to TTS. Wait for a full sentence and the user hears nothing for
 * most of a second after the model has already started answering. Hand over single
 * tokens and the synthesiser has no prosodic context, so it reads a list of words.
 *
 * So the first chunk breaks early — `firstChunkMinChars` is deliberately small — and
 * later chunks prefer sentence boundaries, where a seam is inaudible because a
 * speaker would pause there anyway. That asymmetry is the whole design: buy latency
 * where the user is waiting, buy quality where they are already listening.
 */

export interface ChunkerConfig {
  /** Lower bar for the opening chunk, so speech starts sooner. */
  readonly firstChunkMinChars: number;
  /** Below this, keep accumulating rather than emit a fragment. */
  readonly minChars: number;
  /** Above this, break at the last word boundary regardless of punctuation. */
  readonly maxChars: number;
}

export const DEFAULT_CHUNKER: ChunkerConfig = {
  firstChunkMinChars: 12,
  minChars: 40,
  maxChars: 180,
};

/** Ends a sentence — always a good seam. */
const SENTENCE_END = /[.!?]/;
/** Ends a clause — a good seam once there is enough text to be worth speaking. */
const CLAUSE_END = /[,;:—]/;

/**
 * Words whose trailing period does not end a sentence.
 *
 * Without this, "Mr. Chen" splits after "Mr." and the synthesiser delivers it as two
 * utterances with a beat between them. Not exhaustive and cannot be — this is the
 * short head of a long tail, covering what actually turns up in spoken replies.
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'mt',
  'jr',
  'sr',
  'vs',
  'etc',
  'approx',
  'no',
  'fig',
  'inc',
  'ltd',
  'dept',
]);

export class ClauseChunker {
  readonly #config: ChunkerConfig;
  #buffer = '';
  #emitted = 0;

  constructor(config: Partial<ChunkerConfig> = {}) {
    this.#config = { ...DEFAULT_CHUNKER, ...config };
  }

  get buffered(): string {
    return this.#buffer;
  }

  get chunksEmitted(): number {
    return this.#emitted;
  }

  /** Feed a delta. Returns whatever became speakable, which is usually nothing. */
  push(delta: string): string[] {
    this.#buffer += delta;
    const out: string[] = [];

    for (;;) {
      const cut = this.#findCut();
      if (cut === undefined) break;
      const chunk = this.#buffer.slice(0, cut).trim();
      this.#buffer = this.#buffer.slice(cut);
      if (chunk === '') continue;
      out.push(chunk);
      this.#emitted += 1;
    }
    return out;
  }

  /** Whatever is left when the model stops. Speak it even if it is short. */
  flush(): string | undefined {
    const remaining = this.#buffer.trim();
    this.#buffer = '';
    if (remaining === '') return undefined;
    this.#emitted += 1;
    return remaining;
  }

  reset(): void {
    this.#buffer = '';
    this.#emitted = 0;
  }

  #minChars(): number {
    return this.#emitted === 0 ? this.#config.firstChunkMinChars : this.#config.minChars;
  }

  /** Index to cut at, or `undefined` to keep accumulating. */
  #findCut(): number | undefined {
    // A finished sentence is never a fragment, however short. "Sure." is a better
    // first utterance than the same word glued to the clause behind it, and the
    // minimum length exists to suppress *clause* fragments, not sentences — so
    // sentence seams ignore it entirely.
    const sentence = this.#lastBoundary(SENTENCE_END, 1);
    if (sentence !== undefined) return sentence;

    const min = this.#minChars();
    if (this.#buffer.length < min) return undefined;

    const clause = this.#lastBoundary(CLAUSE_END, min);
    if (clause !== undefined) return clause;

    if (this.#buffer.length >= this.#config.maxChars) {
      const space = this.#buffer.lastIndexOf(' ', this.#config.maxChars);
      return space > min ? space + 1 : this.#config.maxChars;
    }
    return undefined;
  }

  /**
   * First boundary at or after `min` that is followed by whitespace.
   *
   * The trailing-whitespace requirement is what keeps "22.5 degrees" and "Mr. Chen"
   * in one piece: a period inside a number or an abbreviation is not followed by a
   * space, so it is not a seam. Imperfect — "etc. and" would still split — but it
   * catches the cases that actually occur in spoken replies.
   */
  #lastBoundary(pattern: RegExp, min: number): number | undefined {
    for (let i = min - 1; i < this.#buffer.length; i += 1) {
      const char = this.#buffer[i];
      if (char === undefined || !pattern.test(char)) continue;
      const next = this.#buffer[i + 1];
      // End of buffer: more text may still arrive, so this is not yet a seam.
      if (next === undefined) return undefined;
      if (!/\s/.test(next)) continue;
      if (char === '.' && !this.#periodEndsSentence(i)) continue;
      return i + 1;
    }
    return undefined;
  }

  /** Whether the period at `index` genuinely ends a sentence. */
  #periodEndsSentence(index: number): boolean {
    const word = /(\S+)$/.exec(this.#buffer.slice(0, index))?.[1] ?? '';
    // "…at 4." is a sentence; "Section 4. Overview" is a heading we will not see.
    // A lone capital is an initial — "J. Chen" must stay together.
    if (word.length === 1 && /[A-Za-z]/.test(word)) return false;
    return !ABBREVIATIONS.has(word.toLowerCase());
  }
}
