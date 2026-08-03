/**
 * A session event log you can hand to someone else.
 *
 * This exists because of how the last few faults were diagnosed, which is to say
 * badly. Every one of them was invisible from the outside — a rate mismatch that
 * produced no error, a gain node stuck at zero, a transcriber quietly answering
 * nothing — and every one of them was investigated by guessing, changing
 * something, and asking whether it felt different. That loop is slow when the
 * person who can reproduce the fault and the person reading the code are the same
 * person, and it is useless when they are not.
 *
 * A log is the thing that makes a bug report a fact rather than an impression. So
 * the rule here is that every event crossing a boundary gets recorded — both
 * directions of the socket, the audio engine's lifecycle, the detectors, and the
 * server's own view relayed back over the wire so one file contains both halves of
 * the conversation. Correlating two files by wall-clock is exactly the sort of
 * thing that goes wrong when you most need it to work.
 *
 * ## What it is not
 *
 * Not telemetry: nothing leaves the browser unless the user presses the button.
 * Not a metrics pipeline: it is a flat list of records with a timestamp, ordered as
 * they happened, which is the shape that answers "what happened just before it
 * broke".
 */

/** Origin of a record — a log with only one side of the socket in it is half a log. */
export type LogSource = 'browser' | 'server';

export interface LogRecord {
  /** Milliseconds since the session started. Relative, so records line up. */
  readonly t: number;
  readonly source: LogSource;
  /** Dotted category, e.g. `socket.open`, `audio.flush`, `stt.transcript`. */
  readonly kind: string;
  readonly data?: unknown;
}

/**
 * Capacity, in records.
 *
 * Bounded because this runs for the whole session and audio is a firehose — an
 * unbounded array is a memory leak that presents as a browser tab getting slower
 * the longer you use it. Oldest records are dropped first: a fault is diagnosed
 * from what happened *before* it, and the newest records are the ones nearest the
 * symptom. Dropping is counted rather than hidden, so a truncated log says so.
 */
const CAPACITY = 20_000;

export class SessionLog {
  #records: LogRecord[] = [];
  #dropped = 0;
  #startedAt = performance.now();
  #listeners = new Set<() => void>();

  /** Restart the clock. Called when a session opens so `t` is session-relative. */
  reset(): void {
    this.#records = [];
    this.#dropped = 0;
    this.#startedAt = performance.now();
    this.#notify();
  }

  record(source: LogSource, kind: string, data?: unknown): void {
    const t = Math.round(performance.now() - this.#startedAt);
    this.#push({ t, source, kind, ...(data === undefined ? {} : { data }) });
  }

  /**
   * Record something the server already timestamped.
   *
   * The server's clock is its own, so its `at` is treated as authoritative for
   * ordering *within* the server's records and nothing more. Pretending the two
   * clocks are the same would put events in an order that never happened.
   */
  recordServer(kind: string, data?: unknown): void {
    this.record('server', kind, data);
  }

  get size(): number {
    return this.#records.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): readonly LogRecord[] {
    return this.#records;
  }

  /**
   * The downloadable artefact.
   *
   * A header block goes first because a log without the environment that produced
   * it invites the wrong question. Sample rates, user agent, and record counts are
   * exactly the fields that turned out to matter in the faults that prompted this.
   */
  toJson(extra: Record<string, unknown> = {}): string {
    return JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        records: this.#records.length,
        dropped: this.#dropped,
        ...extra,
        log: this.#records,
      },
      replacer,
      2,
    );
  }

  #push(record: LogRecord): void {
    this.#records.push(record);
    if (this.#records.length > CAPACITY) {
      this.#records.splice(0, this.#records.length - CAPACITY);
      this.#dropped += 1;
    }
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Typed arrays serialise to `{"0":1,"1":2,...}`, which is unreadable and enormous.
 * PCM belongs in a log as its shape and level, not its samples.
 */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Int16Array || value instanceof Float32Array) {
    return { type: value.constructor.name, length: value.length };
  }
  return value;
}

/** Trigger a browser download. Kept here so the UI does not grow DOM plumbing. */
export function downloadLog(filename: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking immediately can race the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
