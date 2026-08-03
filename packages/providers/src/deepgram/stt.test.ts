import { describe, expect, it } from 'vitest';

import { DeepgramStt } from './stt.js';

const params = (options: { endpointingMs?: number; utteranceEndMs?: number } = {}) =>
  new URL(new DeepgramStt({ apiKey: 'k', ...options }).listenUrl(16_000)).searchParams;

/**
 * The two numbers that decide whether the assistant lets you finish a sentence.
 * An earlier version had endpointing at 200ms — shorter than a pause for breath —
 * and the assistant answered the first half of sentences. That is worth a test.
 */
describe('DeepgramStt end-of-turn configuration', () => {
  it('waits a conversational pause before calling a segment final', () => {
    expect(Number(params().get('endpointing'))).toBeGreaterThanOrEqual(500);
  });

  it('keeps the UtteranceEnd window at or above the documented floor', () => {
    // Deepgram documents 1000ms as the minimum; below it the window fires inside
    // the interim-result cadence and stops being meaningful.
    expect(Number(params().get('utterance_end_ms'))).toBeGreaterThanOrEqual(1_000);
  });

  it('leaves UtteranceEnd later than speech_final, so it is a backstop', () => {
    const p = params();
    expect(Number(p.get('utterance_end_ms'))).toBeGreaterThan(Number(p.get('endpointing')));
  });

  it('requests interim results, which UtteranceEnd requires', () => {
    expect(params().get('interim_results')).toBe('true');
  });

  it('requests the right model and encoding for the captured audio', () => {
    const p = params();
    expect(p.get('model')).toBe('nova-3');
    expect(p.get('encoding')).toBe('linear16');
    expect(p.get('sample_rate')).toBe('16000');
    expect(p.get('channels')).toBe('1');
  });

  it('honours explicit tuning', () => {
    const p = params({ endpointingMs: 1_100, utteranceEndMs: 2_000 });
    expect(p.get('endpointing')).toBe('1100');
    expect(p.get('utterance_end_ms')).toBe('2000');
  });
});
