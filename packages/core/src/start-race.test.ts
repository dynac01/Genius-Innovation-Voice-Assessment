import { describe, expect, it } from 'vitest';

import { StartRace } from './start-race.js';
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
