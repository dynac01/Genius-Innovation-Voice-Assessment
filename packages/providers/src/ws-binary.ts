/**
 * Turning a WebSocket binary message into samples.
 *
 * Trivial-looking, and it hid the most expensive bug in this project.
 *
 * `ws` hands a binary message over in one of several shapes depending on the
 * socket's `binaryType` and how the frame was fragmented: a Node `Buffer`, a raw
 * `ArrayBuffer`, or an array of `Buffer`s. The TTS provider set `binaryType` to
 * `'arraybuffer'` and then annotated its handler `(data: Buffer)`, which the
 * compiler accepted because an annotation is an assertion, not a check.
 *
 * The consequence is worth spelling out, because the shape of the failure is the
 * lesson. The code read `data.buffer` and `data.byteOffset` — properties a `Buffer`
 * has and an `ArrayBuffer` does not — so both were `undefined`. And
 * `new Uint8Array(undefined, undefined, n)` does not throw: the first argument is
 * coerced to a *length* of zero, producing an empty array. Copying an empty array
 * into a correctly-sized destination leaves it exactly as allocated: all zeros.
 *
 * So every frame had the right byte length, arrived at the right cadence, carried
 * the right character spans, and contained pure silence. Frame counts matched.
 * Timings matched. Nothing threw, nothing warned. The pipeline was verifiably
 * healthy at every checkpoint that counted frames, because counting frames was
 * never the question.
 *
 * This function exists so there is one place that handles every shape, and one
 * place to test that samples actually survive the crossing.
 */

/** Every shape `ws` can deliver a binary message in. */
export type BinaryMessage = ArrayBuffer | ArrayBufferView | readonly ArrayBufferView[];

/**
 * Copy a binary message into freshly-owned 16-bit samples.
 *
 * Always copies. A view onto a Node `Buffer` may be a window into a pooled
 * allocation that is reused the moment the handler returns, and audio frames are
 * queued rather than consumed immediately — so a zero-copy view here would decay
 * into whatever arrived next.
 *
 * An odd trailing byte is dropped rather than being padded into a sample: it can
 * only mean a truncated frame, and half a sample is noise.
 */
export function toInt16Samples(data: BinaryMessage): Int16Array {
  const bytes = toBytes(data);
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  const owned = new ArrayBuffer(usable);
  new Uint8Array(owned).set(bytes.subarray(0, usable));
  return new Int16Array(owned);
}

function toBytes(data: BinaryMessage): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);

  if (Array.isArray(data)) {
    const parts = data as readonly ArrayBufferView[];
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
      offset += part.byteLength;
    }
    return joined;
  }

  const view = data as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
