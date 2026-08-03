/**
 * What an interruption meant.
 *
 * The brief asks for the behaviour to be defined and kept consistent, so the rules
 * live here as data rather than as scattered conditionals, and they are exhaustively
 * table-tested. Getting this wrong is not a crash — it is an assistant that resumes
 * when it should have listened, which is far more annoying and far harder to notice
 * in review.
 *
 * The governing rule: **a control phrase counts only when it is the whole
 * utterance.** "Keep going" resumes; "keep going, but in Spanish" is a new
 * instruction that happens to start with the same words. Substance wins over prefix
 * matching, because the cost of mistaking an instruction for a control word is a
 * dropped request, and the cost of the reverse is one redundant reply.
 */

export type UtteranceIntent =
  /** Continue the paused reply from where it stopped. */
  | 'resume'
  /** Hold. Keep the reply parked and stay quiet until told otherwise. */
  | 'pause'
  /** "mhm", "right" — acknowledgement, not an instruction. Resume automatically. */
  | 'backchannel'
  /** Abandon the reply entirely and say nothing further about it. */
  | 'cancel'
  /** Genuinely new speech. Abandon the old reply; this drives the next one. */
  | 'fresh';

const RESUME = [
  'keep going',
  'keep talking',
  'go on',
  'go ahead',
  'carry on',
  'continue',
  'continue please',
  'please continue',
  'and',
  'so',
];

const PAUSE = [
  'hold on',
  'hang on',
  'wait',
  'wait a moment',
  'wait a second',
  'one sec',
  'one second',
  'just a sec',
  'just a second',
  'give me a second',
  'pause',
  'hold',
];

const CANCEL = [
  'stop',
  'cancel',
  'never mind',
  'nevermind',
  'forget it',
  'forget that',
  'quiet',
  'be quiet',
  'thats enough',
  'enough',
  'stop talking',
  'shut up',
];

const BACKCHANNEL = [
  'mhm',
  'mm',
  'mmm',
  'hmm',
  'uh huh',
  'uhhuh',
  'mm hmm',
  'yeah',
  'yep',
  'yes',
  'ok',
  'okay',
  'right',
  'sure',
  'i see',
  'got it',
  'gotcha',
  'nice',
  'cool',
  'wow',
  'really',
];

/** Disfluencies that carry no intent and should not stop a phrase from matching. */
const FILLER = new Set(['um', 'uh', 'er', 'ah', 'like', 'well', 'so', 'okay', 'ok']);

/**
 * Lowercase, strip punctuation and apostrophes, collapse whitespace.
 *
 * Transcripts arrive with inconsistent punctuation between providers and between
 * partials and finals, so normalising is what keeps the rules from depending on
 * whether the STT felt like adding a comma. Apostrophes go too — "that's" and
 * "thats" are the same instruction, and which one arrives is the provider's whim.
 */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop leading filler, so "um, keep going" still reads as "keep going". */
function stripLeadingFiller(words: string[]): string[] {
  let start = 0;
  while (start < words.length - 1 && FILLER.has(words[start] ?? '')) start += 1;
  return words.slice(start);
}

function match(phrase: string): UtteranceIntent | undefined {
  // Exact match only. A control phrase buried in a longer sentence is not a control
  // phrase — see the note at the top of this file.
  if (CANCEL.includes(phrase)) return 'cancel';
  if (PAUSE.includes(phrase)) return 'pause';
  if (RESUME.includes(phrase)) return 'resume';
  if (BACKCHANNEL.includes(phrase)) return 'backchannel';
  return undefined;
}

export function classifyUtterance(text: string): UtteranceIntent {
  const normalized = normalizeUtterance(text);
  if (normalized === '') return 'backchannel';

  // Try the phrase as spoken before stripping anything: some real phrases *begin*
  // with a word that is filler elsewhere. "uh huh" is a backchannel; "uh" is not
  // part of it that can be discarded.
  const asSpoken = match(normalized);
  if (asSpoken !== undefined) return asSpoken;

  const stripped = stripLeadingFiller(normalized.split(' ')).join(' ');
  return match(stripped) ?? 'fresh';
}

/** What a given intent implies for the reply currently in flight. */
export function bargeInFor(intent: UtteranceIntent): 'stop' | 'pause' | 'finish' {
  switch (intent) {
    case 'resume':
    case 'backchannel':
      return 'finish';
    case 'pause':
      return 'pause';
    case 'cancel':
    case 'fresh':
      return 'stop';
  }
}
