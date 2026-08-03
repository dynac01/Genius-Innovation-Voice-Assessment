/**
 * A push source read as an async iterable.
 *
 * The socket hands us microphone frames whenever they arrive; `STT.transcribeStream`
 * wants an `AudioStream` to pull from. This is the adapter between the two, and it
 * is the reason the loop can stay written against pull-style interfaces while the
 * transport underneath is push-style.
 *
 * Unbounded by choice, with a documented cap: audio arrives at a fixed rate and the
 * consumer keeps up or the session is already failing. A capacity limit that
 * silently dropped frames would corrupt the transcript in a way that is very hard to
 * diagnose, so overflow throws instead.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #buffered: T[] = [];
  readonly #waiting: Array<(result: IteratorResult<T>) => void> = [];
  readonly #capacity: number;
  #closed = false;
  #failure: Error | undefined;

  constructor(capacity = 4_096) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#buffered.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(value: T): void {
    if (this.#closed) return;

    const waiter = this.#waiting.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
      return;
    }

    if (this.#buffered.length >= this.#capacity) {
      throw new RangeError(
        `AsyncQueue overflow at ${this.#capacity} items — the consumer is not keeping up`,
      );
    }
    this.#buffered.push(value);
  }

  /** End the stream once buffered items have been read. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiting.length > 0) {
      this.#waiting.shift()?.({ value: undefined, done: true });
    }
  }

  /** End the stream with an error, surfaced to whoever is iterating. */
  fail(error: Error): void {
    this.#failure ??= error;
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const buffered = this.#buffered.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.#closed) {
        if (this.#failure !== undefined) throw this.#failure;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#waiting.push(resolve);
      });
      if (next.done === true) {
        if (this.#failure !== undefined) throw this.#failure;
        return;
      }
      yield next.value;
    }
  }
}
