import { describe, expect, it } from 'vitest';

import { VirtualClock } from './clock.js';

describe('VirtualClock', () => {
  it('starts at zero and does not move on its own', async () => {
    const clock = new VirtualClock();
    expect(clock.now()).toBe(0);
    await Promise.resolve();
    expect(clock.now()).toBe(0);
  });

  it('accepts a starting time', () => {
    expect(new VirtualClock(1_000).now()).toBe(1_000);
  });

  it('resolves sleep only once time has advanced past it', async () => {
    const clock = new VirtualClock();
    let woke = false;
    void clock.sleep(100).then(() => {
      woke = true;
    });

    await clock.advance(99);
    expect(woke, 'must not wake early').toBe(false);

    await clock.advance(1);
    expect(woke).toBe(true);
    expect(clock.now()).toBe(100);
  });

  it('resolves a zero-length sleep without needing an advance', async () => {
    const clock = new VirtualClock();
    let woke = false;
    void clock.sleep(0).then(() => {
      woke = true;
    });
    await Promise.resolve();
    expect(woke).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('fires timers in due order regardless of registration order', async () => {
    const clock = new VirtualClock();
    const fired: string[] = [];

    void clock.sleep(30).then(() => fired.push('c'));
    void clock.sleep(10).then(() => fired.push('a'));
    void clock.sleep(20).then(() => fired.push('b'));

    await clock.runUntilIdle();
    expect(fired).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties by registration order, not arbitrarily', async () => {
    const clock = new VirtualClock();
    const fired: string[] = [];

    void clock.sleep(10).then(() => fired.push('first'));
    void clock.sleep(10).then(() => fired.push('second'));
    void clock.sleep(10).then(() => fired.push('third'));

    await clock.runUntilIdle();
    expect(fired).toEqual(['first', 'second', 'third']);
  });

  it('lands exactly on the requested time even when no timer is due there', async () => {
    const clock = new VirtualClock();
    void clock.sleep(10);
    await clock.advance(75);
    expect(clock.now()).toBe(75);
  });

  /**
   * The one that matters. A timer that schedules another timer inside the same
   * advance window must still be seen — if `advance` stepped past it, event order
   * would be silently wrong and every timing assertion built on this clock would be
   * quietly meaningless.
   */
  it('sees timers scheduled by timers that fire mid-advance', async () => {
    const clock = new VirtualClock();
    const at: number[] = [];

    void (async () => {
      await clock.sleep(10);
      at.push(clock.now());
      await clock.sleep(10);
      at.push(clock.now());
      await clock.sleep(10);
      at.push(clock.now());
    })();

    await clock.advance(25);
    expect(at).toEqual([10, 20]);
    expect(clock.now()).toBe(25);

    await clock.advance(10);
    expect(at).toEqual([10, 20, 30]);
  });

  /**
   * Pins the MICROTASK_DRAIN_TURNS assumption in clock.ts. Each generator in a chain
   * costs microtask turns to resume; the real loop stacks STT → loop → TTS. If the
   * drain were ever reduced below what a realistic chain needs, this fails loudly
   * instead of producing subtly reordered events.
   */
  it('holds ordering through a deep async generator chain', async () => {
    const clock = new VirtualClock();
    const DEPTH = 12;

    async function* source(): AsyncIterable<number> {
      for (let i = 0; i < 5; i += 1) {
        await clock.sleep(10);
        yield i;
      }
    }

    function relay(upstream: AsyncIterable<number>): AsyncIterable<number> {
      return (async function* () {
        for await (const value of upstream) yield value;
      })();
    }

    let stream: AsyncIterable<number> = source();
    for (let i = 0; i < DEPTH; i += 1) stream = relay(stream);

    const seenAt: Array<[number, number]> = [];
    const consuming = (async () => {
      for await (const value of stream) seenAt.push([value, clock.now()]);
    })();

    await clock.runUntilIdle();
    await consuming;

    expect(seenAt).toEqual([
      [0, 10],
      [1, 20],
      [2, 30],
      [3, 40],
      [4, 50],
    ]);
  });

  it('reports what is still pending', async () => {
    const clock = new VirtualClock();
    void clock.sleep(10);
    void clock.sleep(50);

    expect(clock.pending).toBe(2);
    expect(clock.nextDueAt).toBe(10);

    await clock.advance(10);
    expect(clock.pending).toBe(1);
    expect(clock.nextDueAt).toBe(50);

    await clock.runUntilIdle();
    expect(clock.pending).toBe(0);
    expect(clock.nextDueAt).toBeUndefined();
  });

  it('runUntilIdle returns immediately when nothing is scheduled', async () => {
    const clock = new VirtualClock();
    await clock.runUntilIdle();
    expect(clock.now()).toBe(0);
  });

  it('runUntilIdle fails rather than hangs on a self-rescheduling timer', async () => {
    const clock = new VirtualClock();
    let stop = false;
    void (async () => {
      while (!stop) await clock.sleep(1);
    })();

    await expect(clock.runUntilIdle(25)).rejects.toThrow(/rescheduling itself forever/);
    stop = true;
  });

  it('refuses to run backwards', async () => {
    const clock = new VirtualClock();
    await expect(clock.advance(-1)).rejects.toThrow(RangeError);
  });
});
