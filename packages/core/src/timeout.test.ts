import { describe, expect, it } from 'vitest';

import { VirtualClock } from './clock.js';
import { ProviderStallError, withIdleTimeout } from './timeout.js';

/** Emits `count` items `gapMs` apart, then optionally stalls forever. */
function source(clock: VirtualClock, count: number, gapMs: number, thenStall = false) {
  return (async function* (): AsyncIterable<number> {
    for (let i = 0; i < count; i += 1) {
      await clock.sleep(gapMs);
      yield i;
    }
    if (thenStall) await new Promise<never>(() => undefined);
  })();
}

async function collect(stream: AsyncIterable<number>, clock: VirtualClock): Promise<number[]> {
  const out: number[] = [];
  const consuming = (async () => {
    for await (const value of stream) out.push(value);
  })();
  await clock.runUntilIdle();
  await consuming;
  return out;
}

describe('withIdleTimeout', () => {
  it('passes a healthy source through untouched', async () => {
    const clock = new VirtualClock();
    const wrapped = withIdleTimeout(source(clock, 5, 100), { clock, idleMs: 500, label: 'tts' });
    expect(await collect(wrapped, clock)).toEqual([0, 1, 2, 3, 4]);
  });

  /**
   * The failure that matters: a long reply is not a stall. A wall-clock budget
   * would kill healthy long answers and still miss a provider trickling one item
   * a minute — so the measure is the gap between items, not the total.
   */
  it('allows a long stream so long as items keep arriving', async () => {
    const clock = new VirtualClock();
    const wrapped = withIdleTimeout(source(clock, 50, 100), { clock, idleMs: 300, label: 'llm' });
    expect(await collect(wrapped, clock)).toHaveLength(50);
    expect(clock.now()).toBeGreaterThan(300);
  });

  it('throws when the gap between items exceeds the budget', async () => {
    const clock = new VirtualClock();
    const wrapped = withIdleTimeout(source(clock, 3, 1_000), { clock, idleMs: 400, label: 'stt' });

    const out: number[] = [];
    const consuming = (async () => {
      for await (const value of wrapped) out.push(value);
    })();
    await clock.runUntilIdle();

    await expect(consuming).rejects.toThrow(ProviderStallError);
    expect(out).toEqual([]);
  });

  /** The hang case: items arrive, then the provider simply goes quiet. */
  it('throws when a provider goes silent mid-stream', async () => {
    const clock = new VirtualClock();
    const wrapped = withIdleTimeout(source(clock, 3, 100, true), {
      clock,
      idleMs: 500,
      label: 'tts',
    });

    const out: number[] = [];
    const consuming = (async () => {
      for await (const value of wrapped) out.push(value);
    })();
    await clock.runUntilIdle();

    await expect(consuming).rejects.toThrow(/tts sent nothing for 500ms/);
    expect(out).toEqual([0, 1, 2]);
  });

  it('names the provider that stalled', async () => {
    const clock = new VirtualClock();
    const wrapped = withIdleTimeout(source(clock, 0, 0, true), {
      clock,
      idleMs: 250,
      label: 'deepgram-tts',
    });
    const consuming = (async () => {
      for await (const _ of wrapped) {
        /* drain */
      }
    })();
    await clock.runUntilIdle();

    await expect(consuming).rejects.toMatchObject({
      name: 'ProviderStallError',
      label: 'deepgram-tts',
      idleMs: 250,
    });
  });

  it('closes the wrapped source when the consumer stops early', async () => {
    const clock = new VirtualClock();
    let closed = false;
    const inner = (async function* (): AsyncIterable<number> {
      try {
        for (let i = 0; ; i += 1) {
          await clock.sleep(50);
          yield i;
        }
      } finally {
        closed = true;
      }
    })();

    const wrapped = withIdleTimeout(inner, { clock, idleMs: 500, label: 'llm' });
    const consuming = (async () => {
      for await (const value of wrapped) if (value === 2) break;
    })();
    await clock.runUntilIdle();
    await consuming;

    expect(closed).toBe(true);
  });
});
