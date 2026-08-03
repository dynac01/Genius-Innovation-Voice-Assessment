import { describe, expect, it } from 'vitest';

import { AsyncQueue } from './async-queue.js';

async function collect<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of queue) out.push(value);
  return out;
}

describe('AsyncQueue', () => {
  it('delivers values pushed before anyone reads', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    expect(await collect(queue)).toEqual([1, 2]);
  });

  it('delivers values pushed while a reader waits', async () => {
    const queue = new AsyncQueue<number>();
    const collecting = collect(queue);

    queue.push(1);
    queue.push(2);
    queue.close();

    expect(await collecting).toEqual([1, 2]);
  });

  it('preserves order across both paths', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const collecting = collect(queue);
    queue.push(2);
    queue.push(3);
    queue.close();

    expect(await collecting).toEqual([1, 2, 3]);
  });

  it('ends a waiting reader when closed', async () => {
    const queue = new AsyncQueue<number>();
    const collecting = collect(queue);
    queue.close();
    expect(await collecting).toEqual([]);
  });

  it('ignores pushes after close rather than losing the close', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.close();
    queue.push(2);

    expect(await collect(queue)).toEqual([1]);
    expect(queue.closed).toBe(true);
  });

  it('surfaces a failure to the reader', async () => {
    const queue = new AsyncQueue<number>();
    const collecting = collect(queue);
    queue.fail(new Error('socket died'));

    await expect(collecting).rejects.toThrow('socket died');
  });

  it('drains buffered values before surfacing a failure', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.fail(new Error('socket died'));

    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const value of queue) seen.push(value);
      })(),
    ).rejects.toThrow('socket died');
    expect(seen).toEqual([1]);
  });

  /**
   * Overflow throws rather than dropping. A silently dropped audio frame corrupts
   * the transcript in a way that is near-impossible to trace back to its cause.
   */
  it('throws on overflow instead of dropping frames', () => {
    const queue = new AsyncQueue<number>(3);
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(() => queue.push(4)).toThrow(/overflow/);
  });

  it('reports its depth', () => {
    const queue = new AsyncQueue<number>();
    expect(queue.size).toBe(0);
    queue.push(1);
    expect(queue.size).toBe(1);
  });
});
