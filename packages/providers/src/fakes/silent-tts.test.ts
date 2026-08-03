import { VirtualClock, chunkDurationMs, totalDurationMs } from '@voice/core';
import type { AudioChunk } from '@voice/core';
import { describe, expect, it } from 'vitest';

import { SilentTts } from './silent-tts.js';

const REPLY = 'It is sunny and mild in Lisbon today, around twenty two degrees.';

/** Consume a synthesis, optionally stopping after `stopAfter` frames (a barge-in). */
async function synthesize(
  tts: SilentTts,
  clock: VirtualClock,
  text: string,
  stopAfter?: number,
): Promise<AudioChunk[]> {
  const chunks: AudioChunk[] = [];
  const consuming = (async () => {
    for await (const chunk of tts.synthesizeStream(text)) {
      chunks.push(chunk);
      if (stopAfter !== undefined && chunks.length >= stopAfter) break;
    }
  })();
  await clock.runUntilIdle();
  await consuming;
  return chunks;
}

describe('SilentTts', () => {
  it('emits frames whose total playtime matches the speaking rate', async () => {
    const clock = new VirtualClock();
    const tts = new SilentTts({ clock, charsPerSecond: 15, frameMs: 20 });

    const chunks = await synthesize(tts, clock, REPLY);
    const expectedMs = (REPLY.length / 15) * 1000;
    const actualMs = totalDurationMs(chunks);

    // Duration is quantised up to a whole frame, so it lands in [expected, expected+frame).
    // Asserting that directly beats a fuzzy tolerance, which would also pass for a
    // rate that was simply wrong.
    expect(actualMs).toBeGreaterThanOrEqual(expectedMs);
    expect(actualMs - expectedMs).toBeLessThan(20);
    expect(chunkDurationMs(chunks[0]!)).toBeCloseTo(20, 6);
  });

  it('emits progressively rather than all at once', async () => {
    const clock = new VirtualClock();
    const tts = new SilentTts({ clock, ttfbMs: 60, frameMs: 20 });

    const at: number[] = [];
    const consuming = (async () => {
      for await (const _ of tts.synthesizeStream('hello there friend')) at.push(clock.now());
    })();
    await clock.runUntilIdle();
    await consuming;

    expect(at[0]).toBe(60);
    expect(at[1]! - at[0]!).toBe(20);
    expect(at.at(-1)! - at[0]!).toBeGreaterThan(0);
  });

  /**
   * Spans must tile the input exactly — no gaps, no overlaps, ending on the final
   * character. The Phase 5 offset map is built on this; if the tiling were loose,
   * a resume would land in the wrong place and criterion 2 would fail subtly.
   */
  it('tiles the text with contiguous spans covering every character', async () => {
    const clock = new VirtualClock();
    const tts = new SilentTts({ clock });

    const chunks = await synthesize(tts, clock, REPLY);
    const spans = chunks.map((c) => c.span!);

    expect(spans[0]!.start).toBe(0);
    expect(spans.at(-1)!.end).toBe(REPLY.length);
    for (const [i, span] of spans.entries()) {
      if (i > 0) expect(span.start, `span ${i} must abut its predecessor`).toBe(spans[i - 1]!.end);
      expect(span.end).toBeGreaterThanOrEqual(span.start);
    }
  });

  /**
   * The behaviour criteria 1 and 2 rest on: when the consumer stops mid-reply, the
   * fake records how much was actually heard. That number is the resume point.
   */
  it('records how much was heard when stopped mid-reply', async () => {
    const clock = new VirtualClock();
    const tts = new SilentTts({ clock });

    const chunks = await synthesize(tts, clock, REPLY, 5);
    const request = tts.lastRequest!;

    expect(request.completed, 'a barge-in is not a completed synthesis').toBe(false);
    expect(request.framesEmitted).toBe(5);
    expect(request.charsEmitted).toBe(chunks.at(-1)!.span!.end);
    expect(request.charsEmitted).toBeLessThan(REPLY.length);
    expect(REPLY.slice(0, request.charsEmitted)).toBe(REPLY.slice(0, chunks.at(-1)!.span!.end));
  });

  it('marks a synthesis that ran to the end as complete', async () => {
    const clock = new VirtualClock();
    const tts = new SilentTts({ clock });

    await synthesize(tts, clock, REPLY);
    expect(tts.lastRequest).toMatchObject({ completed: true, charsEmitted: REPLY.length });
  });

  it('emits real silence, and a fresh buffer per frame', async () => {
    const clock = new VirtualClock();
    const tts = new SilentTts({ clock });

    const chunks = await synthesize(tts, clock, 'hello there');
    expect(chunks[0]!.pcm.every((s) => s === 0)).toBe(true);
    expect(chunks[0]!.pcm).not.toBe(chunks[1]!.pcm);
  });

  it('produces nothing for empty text', async () => {
    const clock = new VirtualClock();
    const tts = new SilentTts({ clock });

    expect(await synthesize(tts, clock, '')).toEqual([]);
    expect(tts.lastRequest).toMatchObject({ totalFrames: 0, completed: true });
  });

  it('records every request in order', async () => {
    const clock = new VirtualClock();
    const tts = new SilentTts({ clock });

    await synthesize(tts, clock, 'first');
    await synthesize(tts, clock, 'second');

    expect(tts.requests.map((r) => r.text)).toEqual(['first', 'second']);
  });
});
