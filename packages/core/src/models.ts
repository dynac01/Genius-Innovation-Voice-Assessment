/**
 * The Claude models the browser may choose between.
 *
 * ## Why this is a fixed list rather than a free-text field
 *
 * The model id arrives from the browser, and the browser is untrusted input even
 * though we wrote both ends. Passing an arbitrary string through to a provider API
 * means a malformed session message becomes a request we did not intend to make.
 * A whitelist makes the set of possible requests finite and reviewable.
 *
 * ## Why it lives in core
 *
 * Both ends need it and neither owns it. The browser needs the labels to render a
 * menu; the server needs the ids to validate what came back. Defining it twice is
 * how the two drift, and a drifted menu offers a model the server will refuse.
 *
 * Note what this is *not*: a pluggability boundary. Swapping Deepgram for another
 * synthesiser is a different implementation behind the `TTS` interface — that is
 * criterion 7. Choosing between Claude models is a *parameter* of one
 * implementation, and conflating the two would blur the claim that matters.
 */

export interface ModelOption {
  /** Exact API model id. */
  readonly id: string;
  /** What the menu shows. */
  readonly label: string;
  /** The tradeoff, in the terms that matter to a voice loop. */
  readonly note: string;
}

/**
 * Ordered fastest-first, because that is the axis a voice conversation cares about.
 *
 * In a spoken exchange you hear *silence* until the first clause is synthesised, so
 * time-to-first-token is felt directly in a way that raw capability is not. A
 * cleverer answer that begins a second later is usually the worse experience — which
 * is why the fastest model is the default rather than the most capable one.
 */
export const CLAUDE_MODELS: readonly ModelOption[] = [
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    note: 'Fastest — the default, because time-to-first-word is what a voice loop feels',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    note: 'Balanced — noticeably better answers for a modest delay',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    note: 'Newer balanced tier',
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    note: 'Most capable — and the slowest to start speaking, audibly so',
  },
];

export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0]!.id;

/** True only for ids in the list above. Everything else is treated as absent. */
export function isKnownModel(id: string | undefined): boolean {
  return id !== undefined && CLAUDE_MODELS.some((model) => model.id === id);
}

/**
 * The id to actually use.
 *
 * Falls back rather than throwing: an unrecognised model is a stale browser tab or
 * a hand-edited message, and answering in the default voice is a better outcome
 * than refusing to speak at all.
 */
export function resolveModel(id: string | undefined): string {
  return isKnownModel(id) ? id! : DEFAULT_CLAUDE_MODEL;
}
