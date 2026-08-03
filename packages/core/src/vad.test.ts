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

/**
 * Levels a real microphone actually produces.
 *
 * These tests used to settle the floor on digital silence — which drives it toward
 * -95 dBFS, a level no room reaches — and then call -88 dBFS "speech". That is not
 * a voice by any measure, and encoding it as one is precisely how the detector came
 * to treat room tone as talking. A quiet room sits near -55 dBFS; a person at a
 * normal distance clears -30.
 */
const ROOM_DB = -55;
const SPEECH_DB = -25;
/** Above the room, below a voice: the level the echo guard has to reject. */
const MURMUR_DB = -35;

/** Settle the floor on a realistic room rather than on absolute silence. */
function settle(vad: Vad, frames = 40): void {
  feed(vad, () => tone(ROOM_DB), frames);
}

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
    settle(vad, 30);
    feed(vad, () => tone(SPEECH_DB), 14); // 280ms — clears the 250ms onset guard
    expect(vad.speaking).toBe(true);

    const events = feed(vad, silence, 20);
    expect(events[0]?.[1]).toBe('speech_end');
    expect(events[0]?.[0]).toBe(12); // 13 frames × 20ms = 260ms ≥ 250ms
  });

  /** Word gaps are shorter than the release window, so they must not chatter. */
  it('does not chatter across gaps between words', () => {
    const vad = new Vad({ releaseMs: 250 });
    settle(vad, 30);

    const events: string[] = [];
    for (let word = 0; word < 4; word += 1) {
      for (const [, e] of feed(vad, () => tone(SPEECH_DB), 14)) events.push(e);
      for (const [, e] of feed(vad, () => tone(ROOM_DB), 5)) events.push(e); // 100ms gap
    }
    expect(events).toEqual(['speech_start']);
  });

  it('ignores audio that is merely above silence but not above the floor', () => {
    const vad = new Vad();
    settle(vad);
    expect(feed(vad, () => tone(ROOM_DB + 4), 20)).toEqual([]);
  });

  /**
   * The regression, stated directly.
   *
   * A session log recorded five separate speech runs totalling ~4.3 seconds during
   * which Deepgram — listening to the very same microphone — transcribed nothing.
   * The detector was reporting a room as a person, and each of those reports could
   * destroy a reply.
   *
   * The cause was a purely adaptive threshold. In a quiet room the tracked floor
   * falls toward silence, and a fixed margin above near-silence is still
   * near-silence, so ambient tone clears a bar that has quietly descended to meet
   * it. The absolute gate is what stops the room from redefining a voice.
   */
  it('does not mistake a quiet room for a person', () => {
    const vad = new Vad();
    // A long settle drives the adaptive floor as low as it will go — the exact
    // condition under which the old detector became hair-trigger.
    feed(vad, silence, 200);
    expect(vad.noiseFloorDb).toBeLessThan(ROOM_DB);

    // Ambient room tone, well above that collapsed floor and nowhere near a voice.
    expect(feed(vad, () => tone(ROOM_DB), 100)).toEqual([]);
    expect(vad.speaking).toBe(false);
  });

  it('needs a quarter second of voice, not a click', () => {
    const vad = new Vad();
    settle(vad);
    // A door, a cough, a chair: loud enough, nowhere near long enough.
    expect(feed(vad, () => tone(SPEECH_DB), 8)).toEqual([]);
    expect(vad.speaking).toBe(false);
  });

  /**
   * The echo guard. Residual assistant audio that would trip the detector normally
   * must not while output is active — otherwise the assistant interrupts itself,
   * which looks like barge-in working *too* well and is maddening to diagnose.
   */
  it('raises the bar while the assistant is audible', () => {
    const quiet = new Vad();
    settle(quiet);
    // A murmur counts as speech in a silent room...
    expect(feed(quiet, () => tone(MURMUR_DB), 20).some(([, e]) => e === 'speech_start')).toBe(true);

    // ...and must not while the assistant is talking, because at that level it is
    // far more likely to be the assistant's own voice coming back in.
    const ducked = new Vad();
    settle(ducked);
    ducked.setOutputActive(true);
    expect(feed(ducked, () => tone(MURMUR_DB), 20)).toEqual([]);
  });

  it('still yields to genuinely loud speech over the assistant', () => {
    const vad = new Vad();
    settle(vad);
    vad.setOutputActive(true);
    const events = feed(vad, () => tone(SPEECH_DB), 20);
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
    settle(vad);
    feed(vad, () => tone(SPEECH_DB), 100);
    expect(vad.speaking).toBe(true);
  });

  it('resets to a clean slate', () => {
    const vad = new Vad();
    settle(vad, 30);
    feed(vad, () => tone(SPEECH_DB), 14);
    expect(vad.speaking).toBe(true);

    vad.reset();
    expect(vad.speaking).toBe(false);
    expect(vad.noiseFloorDb).toBe(-55);
  });

  it('rejects a ducked threshold below the open one', () => {
    expect(() => new Vad({ thresholdDb: 16, duckedThresholdDb: 9 })).toThrow(RangeError);
  });
});
