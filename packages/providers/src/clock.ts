import type { Clock } from '@voice/core';

/**
 * The clock that reads the wall.
 *
 * Lives here rather than in @voice/core because it needs `setTimeout`, and core
 * compiles with no platform types in scope. That is the I/O boundary doing its job:
 * the pure half could not have reached for a timer even by accident.
 */
export class SystemClock implements Clock {
  readonly #origin = Date.now();

  now(): number {
    return Date.now() - this.#origin;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
