import { describe, expect, it } from 'vitest';

import { DEFAULT_START_RACE, StartRace, claimFrom } from './start-race.js';
import type { StartRaceInput } from './start-race.js';

const FRAME = 20;

const speaking = (over: 'audible' | 'thinking' | 'nothing'): StartRaceInput => ({
  assistantAudible: over === 'audible',
  assistantThinking: over === 'thinking',
  userSpeaking: true,
  frameMs: FRAME,
});

const quiet = (over: 'audible' | 'thinking' | 'nothing'): StartRaceInput => ({
  assistantAudible: over === 'audible',
  assistantThinking: over === 'thinking',
  userSpeaking: false,
  frameMs: FRAME,
});

/** Feed `count` identical frames and collect the outcomes. */
const feed = (race: StartRace, input: StartRaceInput, count: number): string[] =>
  Array.from({ length: count }, () => race.observe(input));

describe('StartRace — while the assistant is audible', () => {
  it('does nothing when only the assistant is speaking', () => {
    expect(feed(new StartRace(), quiet('audible'), 5)).toEqual(Array(5).fill('none'));
  });

  it('does nothing when only the user is speaking', () => {
    expect(feed(new StartRace(), speaking('nothing'), 5)).toEqual(Array(5).fill('none'));
  });

  /** Ordering 1 — ordinary barge-in. A late stop is the failure everyone hears. */
  it('yields on the first contended frame', () => {
    const race = new StartRace();
    race.observe(quiet('audible'));
    expect(race.observe(speaking('audible'))).toBe('yield');
  });

  /** Ordering 2 — the one an edge-triggered detector misses entirely. */
  it('yields when the assistant starts over an already-speaking user', () => {
    const race = new StartRace();
    feed(race, speaking('nothing'), 5);
    expect(race.observe(speaking('audible'))).toBe('yield');
  });

  it('yields once per contest, not once per frame', () => {
    const race = new StartRace();
    const out = feed(race, speaking('audible'), 20);
    expect(out.filter((o) => o === 'yield')).toHaveLength(1);
  });

  it('re-arms once the contest clears', () => {
    const race = new StartRace();
    expect(race.observe(speaking('audible'))).toBe('yield');
    race.observe(quiet('audible'));
    expect(race.observe(speaking('audible'))).toBe('yield');
  });
});

describe('StartRace — while the assistant is only thinking', () => {
  /**
   * The regression this exists to prevent. Nothing is audible, so there is no
   * late-stop cost to race against — but a false positive silently destroys a
   * reply the user is waiting for, with no sound to explain why. Onset alone is
   * not enough evidence.
   */
  it.each([
    ['a cough', 3],
    ['a chair', 6],
    ['the tail of the last word', 10],
  ])('ignores %s', (_label, frames) => {
    const race = new StartRace({ confirmWhileSilentMs: 400 });
    expect(feed(race, speaking('thinking'), frames)).toEqual(Array(frames).fill('none'));
  });

  it('yields once speech is genuinely sustained', () => {
    const race = new StartRace({ confirmWhileSilentMs: 400 });
    const out = feed(race, speaking('thinking'), 30); // 600ms
    expect(out.filter((o) => o === 'yield')).toHaveLength(1);
    expect(out.indexOf('yield')).toBe(19); // 20 frames × 20ms = 400ms
  });

  it('restarts its evidence when the noise stops', () => {
    const race = new StartRace({ confirmWhileSilentMs: 400 });
    feed(race, speaking('thinking'), 15); // 300ms — not yet enough
    race.observe(quiet('thinking')); // silence resets the case
    expect(feed(race, speaking('thinking'), 15)).toEqual(Array(15).fill('none'));
  });

  it('is stricter while silent than while audible', () => {
    const audible = new StartRace({ confirmWhileSilentMs: 400 });
    const thinking = new StartRace({ confirmWhileSilentMs: 400 });

    expect(audible.observe(speaking('audible'))).toBe('yield');
    expect(thinking.observe(speaking('thinking'))).toBe('none');
  });

  /** Audio starting mid-noise reverts to the fast rule — something is being talked over now. */
  it('yields immediately if audio starts while the noise continues', () => {
    const race = new StartRace({ confirmWhileSilentMs: 400 });
    feed(race, speaking('thinking'), 5);
    expect(race.observe(speaking('audible'))).toBe('yield');
  });
});

describe('StartRace — totality', () => {
  it('never returns anything but none or yield, for any ordering', () => {
    const inputs: StartRaceInput[] = [
      quiet('nothing'),
      quiet('thinking'),
      quiet('audible'),
      speaking('nothing'),
      speaking('thinking'),
      speaking('audible'),
    ];
    for (const a of inputs) {
      for (const b of inputs) {
        for (const c of inputs) {
          const race = new StartRace();
          for (const outcome of [race.observe(a), race.observe(b), race.observe(c)]) {
            expect(['none', 'yield']).toContain(outcome);
          }
        }
      }
    }
  });

  it('is deterministic', () => {
    const run = () => {
      const race = new StartRace();
      return [
        race.observe(speaking('thinking')),
        race.observe(speaking('audible')),
        race.observe(quiet('audible')),
      ];
    };
    expect(run()).toEqual(run());
  });

  it('reports and clears contention', () => {
    const race = new StartRace();
    race.observe(speaking('audible'));
    expect(race.contended).toBe(true);
    race.reset();
    expect(race.contended).toBe(false);
    expect(race.observe(speaking('audible'))).toBe('yield');
  });
});

/**
 * Regression: a reply that has been queued but has not made a sound.
 *
 * These cases come from a real session log, not from imagination. The browser held
 * one flag meaning "audio is scheduled" and passed it as `assistantAudible`, so the
 * ~120ms window between queueing a reply and hearing it was judged by the rule
 * meant for a reply already in the air — yield instantly, demand no confirmation.
 *
 * With a detector still latched from the user's own trailing speech, the result was
 * total and repeating: every reply abandoned in the millisecond it was queued, one
 * character spoken, nothing ever audible, and a transcript that looked healthy
 * throughout. Both turns in that log failed this way.
 */
describe('claimFrom', () => {
  const speakingUser = { userSpeaking: true, frameMs: 20 };

  it('treats queued-but-silent audio as thinking, not as speech', () => {
    expect(claimFrom({ scheduled: true, playing: false, composing: true })).toEqual({
      audible: false,
      thinking: true,
    });
  });

  it('treats audio that has started as audible', () => {
    expect(claimFrom({ scheduled: true, playing: true, composing: false })).toEqual({
      audible: true,
      thinking: false,
    });
  });

  it('still claims the turn once the queue has drained but generation continues', () => {
    expect(claimFrom({ scheduled: false, playing: false, composing: true })).toEqual({
      audible: false,
      thinking: true,
    });
  });

  it('claims nothing when the assistant is idle', () => {
    expect(claimFrom({ scheduled: false, playing: false, composing: false })).toEqual({
      audible: false,
      thinking: false,
    });
  });

  it('does not abandon a just-queued reply to a detector that is already latched', () => {
    const race = new StartRace();
    const queued = claimFrom({ scheduled: true, playing: false, composing: true });

    // The jitter buffer, frame by frame. Nothing has reached the speaker yet, so
    // nothing is being talked over and the reply must survive.
    for (let elapsed = 0; elapsed < 120; elapsed += 20) {
      expect(
        race.observe({
          assistantAudible: queued.audible,
          assistantThinking: queued.thinking,
          ...speakingUser,
        }),
        `yielded ${elapsed}ms in, before a single sample was audible`,
      ).toBe('none');
    }
  });

  it('yields the moment that same reply becomes audible', () => {
    const race = new StartRace();
    const queued = claimFrom({ scheduled: true, playing: false, composing: true });
    for (let elapsed = 0; elapsed < 120; elapsed += 20) {
      race.observe({
        assistantAudible: queued.audible,
        assistantThinking: queued.thinking,
        ...speakingUser,
      });
    }

    const playing = claimFrom({ scheduled: true, playing: true, composing: false });
    expect(
      race.observe({
        assistantAudible: playing.audible,
        assistantThinking: playing.thinking,
        ...speakingUser,
      }),
    ).toBe('yield');
  });

  it('abandons a silent reply once speech has sustained itself', () => {
    const race = new StartRace();
    const queued = claimFrom({ scheduled: true, playing: false, composing: true });
    const outcomes: string[] = [];
    for (let elapsed = 0; elapsed < 600; elapsed += 20) {
      outcomes.push(
        race.observe({
          assistantAudible: queued.audible,
          assistantThinking: queued.thinking,
          ...speakingUser,
        }),
      );
    }
    // Deliberate: the guard delays the decision, it does not remove it. Someone who
    // genuinely keeps talking still gets the turn.
    expect(outcomes).toContain('yield');
    // The frame that fires is the one *completing* the confirmation window, so the
    // speech it has observed is (index + 1) frames long.
    expect((outcomes.indexOf('yield') + 1) * 20).toBeGreaterThanOrEqual(
      DEFAULT_START_RACE.confirmWhileSilentMs,
    );
  });
});

/**
 * Regression: the confirmation window has to start when the contest does.
 *
 * From a session log. The user finished speaking, the transcript finalised, the
 * assistant began thinking — and 14ms later the reply was abandoned having spoken
 * zero characters. The 400ms guard was in the code and did nothing, because the
 * counter it consults had been accumulating since the user first opened their
 * mouth. By the time there was anything to contend with it was already saturated.
 *
 * This is the failure mode a guard is *most* likely to have: present, plausible,
 * and inert. Every turn arrives immediately after the user has been talking, so
 * the pre-loaded counter is not an edge case — it is every single turn.
 */
describe('StartRace confirmation window', () => {
  const frame = (over: 'audible' | 'thinking', speaking = true): StartRaceInput => ({
    assistantAudible: over === 'audible',
    assistantThinking: over === 'thinking',
    userSpeaking: speaking,
    frameMs: 20,
  });

  it('does not spend a reply on speech that predates the assistant claiming a turn', () => {
    const race = new StartRace();

    // Two full seconds of the user talking. No assistant, no contest, nothing to
    // abandon — exactly the run of speech that produces a turn in the first place.
    for (let i = 0; i < 100; i += 1) {
      expect(race.observe({ ...frame('thinking'), assistantThinking: false })).toBe('none');
    }

    // The assistant claims the turn. The guard must begin here, not in the past.
    expect(race.observe(frame('thinking')), 'yielded on the first contended frame').toBe('none');
  });

  it('still yields once the user keeps talking through the claim', () => {
    const race = new StartRace();
    for (let i = 0; i < 100; i += 1) {
      race.observe({ ...frame('thinking'), assistantThinking: false });
    }

    const outcomes: string[] = [];
    for (let i = 0; i < 40; i += 1) outcomes.push(race.observe(frame('thinking')));

    expect(outcomes).toContain('yield');
    expect((outcomes.indexOf('yield') + 1) * 20).toBeGreaterThanOrEqual(
      DEFAULT_START_RACE.confirmWhileSilentMs,
    );
  });

  it('leaves audible replies on the instant rule, where the evidence is the detector', () => {
    const race = new StartRace();
    for (let i = 0; i < 100; i += 1) {
      race.observe({ ...frame('audible'), assistantAudible: false });
    }
    // Nothing to prove here: by the time the detector reports speech at all it has
    // already required a quarter second of it, and there is sound being talked over.
    expect(race.observe(frame('audible'))).toBe('yield');
  });
});
