import { describe, expect, it } from 'vitest';

import { Vad, frameLevelDb } from './vad.js';

const FRAME_MS = 20;
const SAMPLES = 320;

/** A frame at roughly `db` dBFS. */
function tone(db: number, samples = SAMPLES): Int16Array {
  const amplitude = Math.round(10 ** (db / 20) * 32_767 * Math.SQRT2);
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / 16_000) * amplitude);
  }
  return pcm;
}

const silence = (samples = SAMPLES) => new Int16Array(samples);

/** Feed n frames, returning every non-'none' event with its frame index. */
function feed(vad: Vad, frame: () => Int16Array, count: number): Array<[number, string]> {
  const events: Array<[number, string]> = [];
  for (let i = 0; i < count; i += 1) {
    const event = vad.process(frame(), FRAME_MS);
    if (event !== 'none') events.push([i, event]);
  }
  return events;
}

describe('frameLevelDb', () => {
  it('reports digital silence at the floor', () => {
    expect(frameLevelDb(silence())).toBe(-100);
  });

  it('reports an empty frame at the floor', () => {
    expect(frameLevelDb(new Int16Array(0))).toBe(-100);
  });

  it('reports full scale near 0 dBFS', () => {
    const full = new Int16Array(SAMPLES).fill(32_767);
    expect(frameLevelDb(full)).toBeCloseTo(0, 1);
  });

  it('is monotonic in amplitude', () => {
    expect(frameLevelDb(tone(-40))).toBeLessThan(frameLevelDb(tone(-20)));
    expect(frameLevelDb(tone(-20))).toBeLessThan(frameLevelDb(tone(-6)));
  });
});

describe('Vad', () => {
  it('stays quiet through silence', () => {
    const vad = new Vad();
    expect(feed(vad, silence, 50)).toEqual([]);
    expect(vad.speaking).toBe(false);
  });

  /**
   * Onset is the number the brief cares about. 50ms at 20ms frames means the third
   * frame — anything slower shows up as an audible tail on every interruption.
   */
  it('fires onset within the configured window', () => {
    const vad = new Vad({ onsetMs: 50 });
    feed(vad, silence, 30); // settle the floor
    const events = feed(vad, () => tone(-20), 10);

    expect(events[0]?.[1]).toBe('speech_start');
    expect(events[0]?.[0]).toBe(2); // 3 frames × 20ms = 60ms ≥ 50ms
  });

  it('reports onset exactly once per utterance', () => {
    const vad = new Vad();
    feed(vad, silence, 30);
    const events = feed(vad, () => tone(-20), 40);
    expect(events.filter(([, e]) => e === 'speech_start')).toHaveLength(1);
  });

  it('releases only after sustained quiet', () => {
    const vad = new Vad({ releaseMs: 250 });
    feed(vad, silence, 30);
    feed(vad, () => tone(-20), 10);
    expect(vad.speaking).toBe(true);

    const events = feed(vad, silence, 20);
    expect(events[0]?.[1]).toBe('speech_end');
    expect(events[0]?.[0]).toBe(12); // 13 frames × 20ms = 260ms ≥ 250ms
  });

  /** Word gaps are shorter than the release window, so they must not chatter. */
  it('does not chatter across gaps between words', () => {
    const vad = new Vad({ releaseMs: 250 });
    feed(vad, silence, 30);

    const events: string[] = [];
    for (let word = 0; word < 4; word += 1) {
      for (const [, e] of feed(vad, () => tone(-20), 8)) events.push(e);
      for (const [, e] of feed(vad, silence, 5)) events.push(e); // 100ms gap
    }
    expect(events).toEqual(['speech_start']);
  });

  it('ignores audio that is merely above silence but not above the floor', () => {
    const vad = new Vad({ thresholdDb: 9 });
    feed(vad, silence, 40);
    const floor = vad.noiseFloorDb;
    expect(feed(vad, () => tone(floor + 4), 10)).toEqual([]);
  });

  /**
   * The echo guard. Residual assistant audio that would trip the detector normally
   * must not while output is active — otherwise the assistant interrupts itself,
   * which looks like barge-in working *too* well and is maddening to diagnose.
   */
  it('raises the bar while the assistant is audible', () => {
    const quiet = new Vad({ thresholdDb: 9, duckedThresholdDb: 16 });
    feed(quiet, silence, 40);
    const level = quiet.noiseFloorDb + 12;

    // Loud enough to be speech when nothing is playing.
    expect(feed(quiet, () => tone(level), 10).some(([, e]) => e === 'speech_start')).toBe(true);

    const ducked = new Vad({ thresholdDb: 9, duckedThresholdDb: 16 });
    feed(ducked, silence, 40);
    ducked.setOutputActive(true);
    expect(feed(ducked, () => tone(level), 10)).toEqual([]);
  });

  it('still yields to genuinely loud speech over the assistant', () => {
    const vad = new Vad({ duckedThresholdDb: 16 });
    feed(vad, silence, 40);
    vad.setOutputActive(true);
    const events = feed(vad, () => tone(vad.noiseFloorDb + 25), 10);
    expect(events.some(([, e]) => e === 'speech_start')).toBe(true);
  });

  /**
   * Freezing floor adaptation during output matters as much as the raised bar: echo
   * dragging the floor upward would leave the detector numb for seconds after the
   * assistant stops — exactly when the user is most likely to speak.
   */
  it('freezes the noise floor while the assistant is audible', () => {
    const vad = new Vad();
    feed(vad, silence, 40);
    const before = vad.noiseFloorDb;

    vad.setOutputActive(true);
    feed(vad, () => tone(before + 10), 50);
    expect(vad.noiseFloorDb).toBe(before);
  });

  it('settles its floor downward in a quiet room', () => {
    const vad = new Vad();
    const start = vad.noiseFloorDb;
    feed(vad, silence, 30);
    expect(vad.noiseFloorDb).toBeLessThan(start);
  });

  it('does not let sustained speech drag the floor above itself', () => {
    const vad = new Vad();
    feed(vad, silence, 40);
    const floor = vad.noiseFloorDb;
    feed(vad, () => tone(floor + 20), 100);
    expect(vad.speaking).toBe(true);
  });

  it('resets to a clean slate', () => {
    const vad = new Vad();
    feed(vad, silence, 30);
    feed(vad, () => tone(-20), 10);
    expect(vad.speaking).toBe(true);

    vad.reset();
    expect(vad.speaking).toBe(false);
    expect(vad.noiseFloorDb).toBe(-55);
  });

  it('rejects a ducked threshold below the open one', () => {
    expect(() => new Vad({ thresholdDb: 16, duckedThresholdDb: 9 })).toThrow(RangeError);
  });
});
