/**
 * The browser ↔ server wire format.
 *
 * WebSocket carries both frame kinds natively, so control travels as JSON text
 * frames and audio travels as binary. No base64, no envelope around the samples —
 * a 33% size penalty on the highest-volume traffic in the system would be a strange
 * thing to accept for tidiness.
 *
 * This is transport *encoding*, which is pure, so it lives in core and is unit
 * tested. Transport *plumbing* — sockets, upgrades, reconnection — lives in the apps.
 */

import type { TextSpan } from './audio.js';
import type { EarconSound } from './protocol.js';
import type { TurnState } from './turn.js';

/**
 * Which implementation each stage should use, chosen by the browser.
 *
 * Provider choice belongs to the session, not the process. Restarting the server
 * to hear the difference makes the swap a deployment step; making it a message
 * makes it a demonstration — which is what criterion 7 actually asks for.
 *
 * `silent` is TTS-only and exists for that demonstration specifically: the brief
 * defines the swap as "once with a real provider and once with the silent fake".
 */
export interface PipelineSelection {
  readonly stt: 'fake' | 'real';
  readonly llm: 'fake' | 'real';
  readonly tts: 'fake' | 'silent' | 'real';
}

/** Which stages *can* be real — i.e. have a key configured on the server. */
export interface PipelineAvailability {
  readonly stt: boolean;
  readonly llm: boolean;
  readonly tts: boolean;
}

/** Browser → server, as JSON text frames. */
export type ClientEvent =
  | { type: 'hello'; sampleRate: number; providers?: PipelineSelection }
  | { type: 'start' }
  | { type: 'stop' }
  /** Local VAD fired. Audio is already stopping in the browser; this tells the loop. */
  | { type: 'interrupt'; t: number };

export type { TurnState };

/** Server → browser, as JSON text frames. */
export type ServerEvent =
  /**
   * `selected` is what the server actually resolved, which may differ from what
   * was asked for: a stage whose key is missing falls back to its fake. Reporting
   * the resolution rather than the request is what stops the UI claiming a
   * provider that never loaded.
   */
  | {
      type: 'ready';
      sessionId: string;
      available: PipelineAvailability;
      selected: PipelineSelection;
    }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'assistant_text'; text: string }
  | { type: 'earcon'; sound: EarconSound }
  | { type: 'state'; state: TurnState }
  /** Drop buffered audio now — the assistant has been cut off. */
  | { type: 'flush_audio' }
  /**
   * A server-side diagnostic, relayed so the browser's downloadable log contains
   * both halves of the session.
   *
   * Deliberately part of the protocol rather than a side channel. The failures this
   * was built for are the ones where each side looks healthy on its own and only the
   * *pairing* is wrong — a declared sample rate that does not match the samples, a
   * transcriber that answers nothing because of it. Neither log shows that alone,
   * and asking someone to collect two files and correlate them by wall clock is how
   * you end up with one file and a guess.
   */
  | { type: 'log'; at: number; kind: string; data?: unknown }
  | { type: 'error'; message: string };

/**
 * Binary audio frame layout, little-endian:
 *
 *   0   uint8    flags   bit 0 — a span is present
 *   1   uint8    reserved
 *   2   uint16   reserved
 *   4   uint32   seq
 *   8   uint32   spanStart
 *   12  uint32   spanEnd
 *   16  int16[]  pcm, mono
 *
 * The header is 16 bytes so the PCM view is 2-byte aligned and can be taken as a
 * zero-copy `Int16Array` over the same buffer rather than copied out.
 *
 * Samples are little-endian, matching every platform this runs on. A big-endian
 * peer would need a byte swap here; none exists, and paying for one per frame at
 * 50 frames a second to guard against a machine nobody has is not a trade worth
 * making.
 */
export const AUDIO_HEADER_BYTES = 16;

const FLAG_HAS_SPAN = 0x01;

export interface AudioFrame {
  readonly seq: number;
  readonly pcm: Int16Array;
  /** Which characters of the synthesis input this audio renders, when known. */
  readonly span?: TextSpan;
}

export function encodeAudioFrame(frame: AudioFrame): ArrayBuffer {
  const buffer = new ArrayBuffer(AUDIO_HEADER_BYTES + frame.pcm.byteLength);
  const view = new DataView(buffer);

  view.setUint8(0, frame.span === undefined ? 0 : FLAG_HAS_SPAN);
  view.setUint32(4, frame.seq, true);
  view.setUint32(8, frame.span?.start ?? 0, true);
  view.setUint32(12, frame.span?.end ?? 0, true);

  new Int16Array(buffer, AUDIO_HEADER_BYTES).set(frame.pcm);
  return buffer;
}

export function decodeAudioFrame(buffer: ArrayBuffer): AudioFrame {
  if (buffer.byteLength < AUDIO_HEADER_BYTES) {
    throw new RangeError(`audio frame too short: ${buffer.byteLength} bytes`);
  }
  if ((buffer.byteLength - AUDIO_HEADER_BYTES) % 2 !== 0) {
    throw new RangeError('audio frame payload is not a whole number of 16-bit samples');
  }

  const view = new DataView(buffer);
  const flags = view.getUint8(0);
  const seq = view.getUint32(4, true);
  const pcm = new Int16Array(buffer, AUDIO_HEADER_BYTES);

  if ((flags & FLAG_HAS_SPAN) === 0) return { seq, pcm };

  return {
    seq,
    pcm,
    span: { start: view.getUint32(8, true), end: view.getUint32(12, true) },
  };
}

/** Narrowing guards. The wire is untrusted input, even when we wrote both ends. */
export function isClientEvent(value: unknown): value is ClientEvent {
  if (typeof value !== 'object' || value === null) return false;
  const { type } = value as { type?: unknown };
  return type === 'hello' || type === 'start' || type === 'stop' || type === 'interrupt';
}

export function isServerEvent(value: unknown): value is ServerEvent {
  if (typeof value !== 'object' || value === null) return false;
  const { type } = value as { type?: unknown };
  return (
    type === 'ready' ||
    type === 'transcript' ||
    type === 'assistant_text' ||
    type === 'earcon' ||
    type === 'state' ||
    type === 'flush_audio' ||
    type === 'log' ||
    type === 'error'
  );
}
