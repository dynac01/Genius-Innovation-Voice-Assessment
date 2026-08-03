import { describe, expect, it } from 'vitest';

import { StartRace } from './start-race.js';

/** Feed a sequence of [assistantScheduled, userSpeaking] frames. */
const run = (frames: Array<[boolean, boolean]>): string[] => {
  const race = new StartRace();
  return frames.map(([a, u]) => race.observe(a, u));
};

describe('StartRace', () => {
  it('does nothing when neither party is claiming the turn', () => {
    expect(
      run([
        [false, false],
        [false, false],
      ]),
    ).toEqual(['none', 'none']);
  });

  it('does nothing when only the assistant is speaking', () => {
    expect(
      run([
        [true, false],
        [true, false],
        [true, false],
      ]),
    ).toEqual(['none', 'none', 'none']);
  });

  it('does nothing when only the user is speaking', () => {
    expect(
      run([
        [false, true],
        [false, true],
      ]),
    ).toEqual(['none', 'none']);
  });

  /** Ordering 1 — ordinary barge-in: the assistant is talking and the user starts. */
  it('yields when the user starts over a speaking assistant', () => {
    expect(
      run([
        [true, false],
        [true, true],
        [true, true],
      ]),
    ).toEqual(['none', 'yield', 'none']);
  });

  /**
   * Ordering 2 — the one an edge-triggered detector misses. The user was already
   * mid-sentence, so there is no rising edge on their speech; without level
   * detection the assistant talks straight over them.
   */
  it('yields when the assistant starts over a speaking user', () => {
    expect(
      run([
        [false, true],
        [true, true],
        [true, true],
      ]),
    ).toEqual(['none', 'yield', 'none']);
  });

  it('yields when both start on the very same frame', () => {
    expect(
      run([
        [false, false],
        [true, true],
      ]),
    ).toEqual(['none', 'yield']);
  });

  /** Re-yielding every frame would stop the assistant ever recovering. */
  it('yields once per contest, not once per frame', () => {
    const outcomes = run([
      [true, false],
      [true, true],
      [true, true],
      [true, true],
      [true, true],
    ]);
    expect(outcomes.filter((o) => o === 'yield')).toHaveLength(1);
  });

  it('re-arms after the contest clears', () => {
    expect(
      run([
        [true, true], // contest 1
        [true, false], // user stops
        [true, true], // contest 2
      ]),
    ).toEqual(['yield', 'none', 'yield']);
  });

  it('re-arms when the assistant stops rather than the user', () => {
    expect(
      run([
        [true, true],
        [false, true], // assistant stops; user still talking
        [true, true], // assistant tries again
      ]),
    ).toEqual(['yield', 'none', 'yield']);
  });

  /**
   * Deadlock is impossible by construction: yielding is unilateral, so there is no
   * observation sequence in which the assistant is asked to wait for the user
   * while the user waits for the assistant. Exhaustively: no input ever produces
   * an outcome other than 'none' or 'yield', and 'yield' always resolves contention
   * in the same direction.
   */
  it('is total and deterministic over every ordering', () => {
    const inputs: Array<[boolean, boolean]> = [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ];
    for (const first of inputs) {
      for (const second of inputs) {
        for (const third of inputs) {
          const a = run([first, second, third]);
          const b = run([first, second, third]);
          expect(a, `${JSON.stringify([first, second, third])}`).toEqual(b);
          for (const outcome of a) expect(['none', 'yield']).toContain(outcome);
        }
      }
    }
  });

  it('reports and clears its contention state', () => {
    const race = new StartRace();
    race.observe(true, true);
    expect(race.contended).toBe(true);
    race.reset();
    expect(race.contended).toBe(false);
    expect(race.observe(true, true)).toBe('yield');
  });
});
