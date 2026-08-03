import { describe, expect, it } from 'vitest';

import { EARCONS, EARCON_MAX_MS, EARCON_SOUNDS, earconDurationMs, earconPeak } from './earcons.js';

describe('earcon specifications', () => {
  it('covers all four states the protocol defines', () => {
    expect(EARCON_SOUNDS.sort()).toEqual(['accepted', 'failed', 'listening', 'ready']);
  });

  /** "Each under half a second" — the brief's ceiling, asserted rather than assumed. */
  it.each(EARCON_SOUNDS)('%s is under half a second', (sound) => {
    const ms = earconDurationMs(EARCONS[sound]);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(EARCON_MAX_MS);
  });

  /**
   * Non-fatiguing means quiet. These sit under speech rather than over it, and a
   * peak anywhere near unity would make every acknowledgement feel like an alarm.
   */
  it.each(EARCON_SOUNDS)('%s is quiet enough to live under speech', (sound) => {
    expect(earconPeak(EARCONS[sound])).toBeLessThanOrEqual(0.1);
  });

  /**
   * Every tone ramps in and out. A hard start or stop lands on a non-zero sample and
   * clicks — and a click heard forty times an hour is precisely the fatigue the
   * brief warns about.
   */
  it.each(EARCON_SOUNDS)('%s ramps every tone in and out', (sound) => {
    for (const t of EARCONS[sound].tones) {
      expect(t.attackMs, 'attack').toBeGreaterThan(0);
      expect(t.releaseMs, 'release').toBeGreaterThan(0);
      expect(t.attackMs + t.releaseMs).toBeLessThanOrEqual(t.durationMs + t.releaseMs);
    }
  });

  it('gives every earcon a distinct signature', () => {
    const signatures = EARCON_SOUNDS.map((sound) =>
      EARCONS[sound].tones.map((t) => `${t.fromHz}>${t.toHz}@${t.durationMs}`).join('+'),
    );
    expect(new Set(signatures).size).toBe(EARCON_SOUNDS.length);
  });

  it('descends on failure and does not elsewhere', () => {
    const failed = EARCONS.failed.tones[0]!;
    expect(failed.toHz).toBeLessThan(failed.fromHz);

    for (const sound of ['listening', 'accepted', 'ready'] as const) {
      for (const t of EARCONS[sound].tones) expect(t.toHz).toBeGreaterThanOrEqual(t.fromHz);
    }
  });

  it('builds the ready chime from overlapping partials', () => {
    const tones = EARCONS.ready.tones;
    expect(tones.length).toBeGreaterThan(1);

    // The second partial starts before the first has finished — that overlap is what
    // makes it read as one chime rather than two beeps.
    const [first, second] = tones;
    expect(second!.startMs).toBeGreaterThan(0);
    expect(second!.startMs).toBeLessThan(first!.startMs + first!.durationMs);
    expect(second!.fromHz).toBeGreaterThan(first!.fromHz);
  });

  it('keeps the two most frequent sounds the quietest', () => {
    // `listening` and `accepted` fire every session and every turn; `failed` should
    // stand out against them.
    expect(earconPeak(EARCONS.listening)).toBeLessThan(earconPeak(EARCONS.failed));
    expect(earconPeak(EARCONS.accepted)).toBeLessThan(earconPeak(EARCONS.failed));
  });

  it('keeps every tone in a comfortable register', () => {
    for (const sound of EARCON_SOUNDS) {
      for (const t of EARCONS[sound].tones) {
        expect(t.fromHz).toBeGreaterThan(200);
        expect(t.fromHz).toBeLessThan(2_000);
        expect(t.toHz).toBeGreaterThan(200);
        expect(t.toHz).toBeLessThan(2_000);
      }
    }
  });
});
