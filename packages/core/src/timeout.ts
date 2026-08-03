/**
 * A stalled provider must fail, not hang.
 *
 * The brief's wording is precise: a provider hiccup mid-reply should surface "a
 * failed earcon rather than hanging". A provider that returns an error is the easy
 * case — it propagates. The hard case is a provider that simply stops sending: the
 * socket stays open, no error is raised, and the loop waits forever for a chunk
 * that will never arrive. From the user's side that is indistinguishable from the
 * assistant having nothing to say, which is the worst possible failure mode
 * because nothing anywhere reports a problem.
 *
 * This measures *idle* time between items rather than total duration. A long reply
 * is not a stall, and a wall-clock budget would kill healthy long answers while
 * still missing a provider that trickles one byte a minute.
 */

import type { Clock } from './clock.js';

export class ProviderStallError extends Error {
  constructor(
    readonly label: string,
    readonly idleMs: number,
  ) {
    super(`${label} sent nothing for ${idleMs}ms`);
    this.name = 'ProviderStallError';
  }
}

export interface IdleTimeoutOptions {
  readonly clock: Clock;
  /** Maximum silence between items before the source is declared stalled. */
  readonly idleMs: number;
  /** Named in the error, so a hung turn says which provider hung. */
  readonly label: string;
}

/**
 * Wraps a source so that a gap longer than `idleMs` between items throws.
 *
 * The wrapped source is asked to close on the way out, but **not awaited**, and
 * that detail is the whole point. Closing an async generator suspended inside an
 * `await` does not resume it — the returned promise settles only once the thing it
 * is waiting on settles, which for a stalled provider is never. Awaiting cleanup
 * here would therefore hang on precisely the provider this function exists to
 * escape, turning the timeout into an elaborate way of hanging anyway.
 *
 * So the close is fire-and-forget: the request to release the socket is made, and
 * whether the provider honours it is not allowed to block anyone.
 */
export function withIdleTimeout<T>(
  source: AsyncIterable<T>,
  options: IdleTimeoutOptions,
): AsyncIterable<T> {
  const { clock, idleMs, label } = options;

  return (async function* (): AsyncIterable<T> {
    const iterator = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        // `undefined` marks the timeout winning. A sentinel object or symbol
        // would read better but neither narrows through `Promise.race`, and an
        // iterator result is never undefined, so this discriminates cleanly.
        const next = await Promise.race([
          iterator.next(),
          clock.sleep(idleMs).then(() => undefined),
        ]);

        if (next === undefined) throw new ProviderStallError(label, idleMs);
        if (next.done === true) return;
        yield next.value;
      }
    } finally {
      void iterator.return?.(undefined);
    }
  })();
}
