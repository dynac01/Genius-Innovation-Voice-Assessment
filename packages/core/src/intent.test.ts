import { describe, expect, it } from 'vitest';

import { bargeInFor, classifyUtterance, normalizeUtterance } from './intent.js';
import type { UtteranceIntent } from './intent.js';

describe('normalizeUtterance', () => {
  it.each([
    ['Keep going!', 'keep going'],
    ['  HOLD   ON.  ', 'hold on'],
    // Apostrophes go: which of "that's" / "thats" arrives is the provider's whim,
    // and the rules must not depend on it.
    ["that's enough", 'thats enough'],
    ['that’s enough', 'thats enough'],
    ['Wait — one second…', 'wait one second'],
    ['', ''],
    ['???', ''],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeUtterance(input)).toBe(expected);
  });
});

describe('classifyUtterance', () => {
  const table: Array<[string, UtteranceIntent]> = [
    // resume
    ['keep going', 'resume'],
    ['Keep going.', 'resume'],
    ['go on', 'resume'],
    ['carry on', 'resume'],
    ['continue', 'resume'],
    ['please continue', 'resume'],
    ['um, keep going', 'resume'],

    // pause
    ['hold on', 'pause'],
    ['hang on', 'pause'],
    ['wait', 'pause'],
    ['one sec', 'pause'],
    ['just a second', 'pause'],
    ['Wait!', 'pause'],

    // cancel
    ['stop', 'cancel'],
    ['never mind', 'cancel'],
    ['forget it', 'cancel'],
    ["that's enough", 'cancel'],
    ['be quiet', 'cancel'],

    // backchannel
    ['mhm', 'backchannel'],
    ['yeah', 'backchannel'],
    ['right', 'backchannel'],
    ['ok', 'backchannel'],
    ['got it', 'backchannel'],
    ['uh huh', 'backchannel'],
    ['', 'backchannel'],

    // fresh
    ['what is the weather in Lisbon', 'fresh'],
    ['book me a table for four', 'fresh'],
    ['tell me something else', 'fresh'],
  ];

  it.each(table)('%j -> %s', (text, expected) => {
    expect(classifyUtterance(text)).toBe(expected);
  });

  /**
   * The governing rule, and the one most worth pinning: a control phrase counts only
   * as the *whole* utterance. Mistaking an instruction for a control word drops the
   * user's request silently; the reverse costs one redundant reply.
   */
  it.each([
    'keep going but in Spanish',
    'wait what did you say about Lisbon',
    'stop and tell me the time instead',
    'yeah but what about tomorrow',
    'okay so what is the forecast',
    'continue with the second option',
  ])('treats %j as a fresh turn, not a control phrase', (text) => {
    expect(classifyUtterance(text)).toBe('fresh');
  });

  it('is case and punctuation insensitive', () => {
    for (const variant of ['KEEP GOING', 'Keep Going!', 'keep going...', '  keep going  ']) {
      expect(classifyUtterance(variant), variant).toBe('resume');
    }
  });
});

describe('bargeInFor', () => {
  it.each([
    ['resume', 'finish'],
    ['backchannel', 'finish'],
    ['pause', 'pause'],
    ['cancel', 'stop'],
    ['fresh', 'stop'],
  ] as const)('%s -> barge_in: %s', (intent, expected) => {
    expect(bargeInFor(intent)).toBe(expected);
  });

  it('maps every intent to a protocol behaviour', () => {
    const intents: UtteranceIntent[] = ['resume', 'pause', 'backchannel', 'cancel', 'fresh'];
    for (const intent of intents) {
      expect(['stop', 'pause', 'finish']).toContain(bargeInFor(intent));
    }
  });
});
