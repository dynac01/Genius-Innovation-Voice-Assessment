import { describe, expect, it } from 'vitest';

import { Endpointer } from './endpointer.js';

const speech = (text: string, at: number, final = false) =>
  ({ type: 'transcript', text, final, at }) as const;
const tick = (at: number) => ({ type: 'tick', at }) as const;

describe('Endpointer', () => {
  it('says nothing before any speech', () => {
    const ep = new Endpointer();
    expect(ep.observe(tick(5_000))).toEqual({ type: 'none' });
    expect(ep.wakeAt).toBeUndefined();
  });

  it('holds the turn open while speech keeps arriving', () => {
    const ep = new Endpointer({ endOfTurnMs: 700, pauseMs: 300 });
    expect(ep.observe(speech('what', 0))).toEqual({ type: 'none' });
    expect(ep.observe(speech('what is', 200))).toEqual({ type: 'none' });
    expect(ep.observe(tick(400))).toEqual({ type: 'none' });
  });

  it('reports a pause without ending the turn', () => {
    const ep = new Endpointer({ endOfTurnMs: 700, pauseMs: 300 });
    ep.observe(speech('what is', 0));
    expect(ep.observe(tick(300))).toEqual({ type: 'pause', at: 300 });
    expect(ep.observe(tick(500))).toEqual({ type: 'none' });
  });

  it('reports a pause only once per silence', () => {
    const ep = new Endpointer({ endOfTurnMs: 700, pauseMs: 300 });
    ep.observe(speech('hello', 0));
    expect(ep.observe(tick(320)).type).toBe('pause');
    expect(ep.observe(tick(400)).type).toBe('none');
    expect(ep.observe(tick(500)).type).toBe('none');
  });

  it('ends the turn after the full silence window', () => {
    const ep = new Endpointer({ endOfTurnMs: 700, pauseMs: 300 });
    ep.observe(speech('what is the weather', 0));
    ep.observe(tick(300));
    expect(ep.observe(tick(700))).toEqual({
      type: 'endpoint',
      text: 'what is the weather',
      at: 700,
    });
  });

  /**
   * Criterion 4, exactly as the brief words it: a partial, a short gap, then more
   * speech — the assistant must wait. The gap here (400ms) is long enough to trip
   * the pause report and must still not end the turn.
   */
  it('waits through a mid-sentence pause and does not cut the user off', () => {
    const ep = new Endpointer({ endOfTurnMs: 700, pauseMs: 300 });

    ep.observe(speech('book me a table for', 0));
    expect(ep.observe(tick(300)).type).toBe('pause');
    expect(ep.observe(tick(400)).type).toBe('none');

    // The user resumes inside the window.
    expect(ep.observe(speech('book me a table for four', 400)).type).toBe('none');

    // 700 is past the *original* deadline, so a detector that failed to re-arm would
    // end the turn here — cutting the user off mid-sentence. Reporting a second
    // hesitation is fine and expected (300ms of fresh silence since the resumed
    // speech); ending the turn is not.
    expect(ep.observe(tick(700)).type).toBe('pause');
    expect(ep.observe(tick(900)).type).toBe('none');

    // Only sustained silence after the *later* speech ends the turn.
    expect(ep.observe(tick(1_100))).toEqual({
      type: 'endpoint',
      text: 'book me a table for four',
      at: 1_100,
    });
  });

  it('re-arms its deadline from the most recent speech', () => {
    const ep = new Endpointer({ endOfTurnMs: 700, pauseMs: 300 });
    ep.observe(speech('one', 0));
    expect(ep.wakeAt).toBe(300);

    ep.observe(tick(300));
    expect(ep.wakeAt).toBe(700);

    ep.observe(speech('one two', 500));
    expect(ep.wakeAt).toBe(800);
  });

  it('ends immediately on a trusted STT final', () => {
    const ep = new Endpointer({ trustSttFinal: true });
    expect(ep.observe(speech('all done', 120, true))).toEqual({
      type: 'endpoint',
      text: 'all done',
      at: 120,
    });
  });

  it('ignores a final when the provider is not trusted to endpoint', () => {
    const ep = new Endpointer({ trustSttFinal: false, endOfTurnMs: 700, pauseMs: 300 });
    expect(ep.observe(speech('all done', 0, true)).type).toBe('none');
    expect(ep.observe(tick(700)).type).toBe('endpoint');
  });

  /** An empty partial means "still nothing", not speech. */
  it.each(['', '   ', '\n'])('does not treat %j as speech', (text) => {
    const ep = new Endpointer();
    expect(ep.observe(speech(text, 0)).type).toBe('none');
    expect(ep.wakeAt).toBeUndefined();
  });

  it('stays quiet after ending until reset', () => {
    const ep = new Endpointer({ endOfTurnMs: 700, pauseMs: 300 });
    ep.observe(speech('hi', 0));
    expect(ep.observe(tick(700)).type).toBe('endpoint');
    expect(ep.observe(tick(2_000)).type).toBe('none');
    expect(ep.wakeAt).toBeUndefined();

    ep.reset();
    ep.observe(speech('again', 3_000));
    expect(ep.wakeAt).toBe(3_300);
  });

  it('rejects a config whose pause deadline is not before its endpoint', () => {
    expect(() => new Endpointer({ pauseMs: 700, endOfTurnMs: 700 })).toThrow(RangeError);
    expect(() => new Endpointer({ pauseMs: 900, endOfTurnMs: 700 })).toThrow(/must be below/);
  });
});
