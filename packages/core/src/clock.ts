/**
 * Time, as an injected dependency.
 *
 * Every timing decision in this system — endpointing windows, barge-in onset,
 * provider pacing — reads the clock rather than the wall. That makes the whole loop
 * drivable in virtual time, which is what keeps the control-flow suite both
 * deterministic and fast: a test asserting "the assistant waits through a 400ms
 * mid-sentence pause" should not take 400ms, and must not be able to flake because
 * a CI runner stalled.
 *
 * Note what is absent: `setTimeout`. This package compiles with `"types": []`, so
 * no platform timer API is even in scope. {@link VirtualClock} needs none — it is
 * a sorted list and some arithmetic. The clock that wraps real timers lives in
 * @voice/providers, on the other side of the I/O boundary.
 */

export interface Clock {
  /** Milliseconds since this clock's origin. Monotonic. */
  now(): number;
  /** Resolves once `ms` have elapsed on this clock. */
  sleep(ms: number): Promise<void>;
}

interface PendingTimer {
  readonly dueAt: number;
  readonly seq: number;
  readonly fire: () => void;
}

/**
 * Microtask turns drained after firing each timer.
 *
 * Resuming a `sleep` only schedules the *next* one after the awaiting code runs,
 * and that code may sit behind a chain of async generators — STT → loop → TTS —
 * each costing turns. Draining too few would let `advance` step past a timer that
 * had not been registered yet, silently reordering events.
 *
 * 50 is far above any chain depth here and costs microseconds. `deepChainDepth` in
 * the tests pins the assumption so it fails loudly rather than drifting.
 */
const MICROTASK_DRAIN_TURNS = 50;

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < MICROTASK_DRAIN_TURNS; i += 1) await Promise.resolve();
}

/**
 * A clock that only moves when told to.
 *
 * Pure: no timers, no platform APIs, no hidden state. `advance` fires due timers in
 * (dueAt, registration) order, so simultaneous wakeups resolve in the order they
 * were scheduled rather than whatever the runtime feels like.
 */
export class VirtualClock implements Clock {
  #now: number;
  #seq = 0;
  #pending: PendingTimer[] = [];

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#pending.push({ dueAt: this.#now + ms, seq: this.#seq, fire: resolve });
      this.#seq += 1;
    });
  }

  /** Timers still waiting. Useful for asserting nothing was left dangling. */
  get pending(): number {
    return this.#pending.length;
  }

  /** Virtual time at which the next timer is due, or `undefined` if none. */
  get nextDueAt(): number | undefined {
    return this.#earliest()?.dueAt;
  }

  /** Advance by `ms`, firing every timer that comes due along the way. */
  async advance(ms: number): Promise<void> {
    if (ms < 0) throw new RangeError('cannot advance a clock backwards');
    const target = this.#now + ms;

    for (;;) {
      const next = this.#earliest();
      if (next === undefined || next.dueAt > target) break;
      this.#now = next.dueAt;
      this.#pending.splice(this.#pending.indexOf(next), 1);
      next.fire();
      await drainMicrotasks();
    }

    this.#now = target;
    await drainMicrotasks();
  }

  /**
   * Jump straight to each pending timer until none remain.
   *
   * The usual way to drive a scripted conversation: start the pipeline, then let it
   * run to completion without having to know the total duration in advance.
   *
   * `maxSteps` is a runaway guard — a fake that reschedules itself forever would
   * otherwise hang the suite instead of failing it.
   */
  async runUntilIdle(maxSteps = 10_000): Promise<void> {
    for (let step = 0; step < maxSteps; step += 1) {
      const next = this.#earliest();
      if (next === undefined) return;
      await this.advance(next.dueAt - this.#now);
    }
    throw new Error(
      `VirtualClock.runUntilIdle exceeded ${maxSteps} steps — a timer is likely rescheduling itself forever`,
    );
  }

  #earliest(): PendingTimer | undefined {
    let best: PendingTimer | undefined;
    for (const timer of this.#pending) {
      if (
        best === undefined ||
        timer.dueAt < best.dueAt ||
        (timer.dueAt === best.dueAt && timer.seq < best.seq)
      ) {
        best = timer;
      }
    }
    return best;
  }
}
