import { describe, expect, it } from 'vitest';

import {
  AUDIO_HEADER_BYTES,
  decodeAudioFrame,
  encodeAudioFrame,
  isClientEvent,
  isServerEvent,
} from './wire.js';

const pcm = (...samples: number[]): Int16Array => Int16Array.from(samples);

describe('audio frame codec', () => {
  it('round-trips samples and sequence', () => {
    const frame = { seq: 42, pcm: pcm(0, 1, -1, 32767, -32768) };
    const decoded = decodeAudioFrame(encodeAudioFrame(frame));

    expect(decoded.seq).toBe(42);
    expect([...decoded.pcm]).toEqual([0, 1, -1, 32767, -32768]);
    expect(decoded.span).toBeUndefined();
  });

  it('round-trips a span when one is present', () => {
    const decoded = decodeAudioFrame(
      encodeAudioFrame({ seq: 7, pcm: pcm(1, 2), span: { start: 10, end: 25 } }),
    );
    expect(decoded.span).toEqual({ start: 10, end: 25 });
  });

  /** [0,0) is a real span. A flag distinguishes it from "no span"; zeroes cannot. */
  it('distinguishes an empty span from an absent one', () => {
    const empty = decodeAudioFrame(
      encodeAudioFrame({ seq: 1, pcm: pcm(0), span: { start: 0, end: 0 } }),
    );
    const absent = decodeAudioFrame(encodeAudioFrame({ seq: 1, pcm: pcm(0) }));

    expect(empty.span).toEqual({ start: 0, end: 0 });
    expect(absent.span).toBeUndefined();
  });

  it('carries an empty payload', () => {
    const decoded = decodeAudioFrame(encodeAudioFrame({ seq: 0, pcm: pcm() }));
    expect(decoded.pcm).toHaveLength(0);
  });

  it('uses a header that keeps the payload 16-bit aligned', () => {
    expect(AUDIO_HEADER_BYTES % 2).toBe(0);
    const encoded = encodeAudioFrame({ seq: 1, pcm: pcm(1, 2, 3) });
    expect(encoded.byteLength).toBe(AUDIO_HEADER_BYTES + 6);
  });

  it('survives a realistic 20ms frame at 16kHz', () => {
    const samples = Int16Array.from({ length: 320 }, (_, i) => (i % 2 === 0 ? 1000 : -1000));
    const decoded = decodeAudioFrame(encodeAudioFrame({ seq: 99, pcm: samples }));
    expect([...decoded.pcm]).toEqual([...samples]);
  });

  it('rejects a truncated header', () => {
    expect(() => decodeAudioFrame(new ArrayBuffer(8))).toThrow(/too short/);
  });

  it('rejects a payload that is not whole samples', () => {
    expect(() => decodeAudioFrame(new ArrayBuffer(AUDIO_HEADER_BYTES + 1))).toThrow(/whole number/);
  });
});

describe('event guards', () => {
  it.each([
    [{ type: 'hello', sampleRate: 16000 }, true],
    [
      { type: 'hello', sampleRate: 16000, providers: { stt: 'real', llm: 'fake', tts: 'silent' } },
      true,
    ],
    [{ type: 'start' }, true],
    [{ type: 'interrupt', t: 12 }, true],
    [{ type: 'ready' }, false],
    [{ type: 'nonsense' }, false],
    [null, false],
    ['start', false],
  ])('isClientEvent(%j) = %s', (value, expected) => {
    expect(isClientEvent(value)).toBe(expected);
  });

  it.each([
    [{ type: 'ready', sessionId: 'a' }, true],
    [
      {
        type: 'ready',
        sessionId: 'a',
        available: { stt: true, llm: true, tts: false },
        selected: { stt: 'real', llm: 'real', tts: 'fake' },
      },
      true,
    ],
    [{ type: 'transcript', text: 'hi', final: false }, true],
    [{ type: 'flush_audio' }, true],
    [{ type: 'start' }, false],
    [undefined, false],
  ])('isServerEvent(%j) = %s', (value, expected) => {
    expect(isServerEvent(value)).toBe(expected);
  });
});
