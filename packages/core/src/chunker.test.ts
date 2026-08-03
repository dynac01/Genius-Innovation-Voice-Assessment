import { describe, expect, it } from 'vitest';

import { ClauseChunker } from './chunker.js';

/** Feed a whole reply token-by-token, as a streaming model would. */
function streamThrough(chunker: ClauseChunker, text: string): string[] {
  const out: string[] = [];
  for (const token of text.match(/\S+\s*/g) ?? []) out.push(...chunker.push(token));
  const tail = chunker.flush();
  if (tail !== undefined) out.push(tail);
  return out;
}

describe('ClauseChunker', () => {
  it('loses nothing across a whole reply', () => {
    const reply = 'It is sunny and mild in Lisbon today, around twenty two degrees. Enjoy it.';
    const chunks = streamThrough(new ClauseChunker(), reply);
    expect(chunks.join(' ')).toBe(reply);
  });

  it('holds back until there is something worth speaking', () => {
    const chunker = new ClauseChunker({ firstChunkMinChars: 12, minChars: 40 });
    expect(chunker.push('Hi')).toEqual([]);
    expect(chunker.push(' there')).toEqual([]);
    expect(chunker.buffered).toBe('Hi there');
  });

  /**
   * The latency decision this class exists for. Time-to-first-audio is dominated by
   * how long the first chunk is withheld, so it breaks early — and later chunks,
   * where the user is already listening, wait for a better seam.
   */
  it('breaks the opening chunk earlier than later ones', () => {
    const chunker = new ClauseChunker({ firstChunkMinChars: 12, minChars: 60 });
    const reply = 'Sure thing. That will take about ten minutes, give or take a little.';
    const chunks = streamThrough(chunker, reply);

    expect(chunks[0]).toBe('Sure thing.');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]!.length).toBeGreaterThan(chunks[0]!.length);
  });

  it('prefers sentence boundaries', () => {
    const chunker = new ClauseChunker({ firstChunkMinChars: 5, minChars: 5 });
    expect(streamThrough(chunker, 'One two. Three four. Five six.')).toEqual([
      'One two.',
      'Three four.',
      'Five six.',
    ]);
  });

  it('falls back to clause boundaries when no sentence ends', () => {
    const chunker = new ClauseChunker({ firstChunkMinChars: 8, minChars: 8 });
    const chunks = streamThrough(chunker, 'first part, second part, third part');
    expect(chunks[0]).toBe('first part,');
  });

  /**
   * A period inside a number or an abbreviation is not a seam. Requiring trailing
   * whitespace is what keeps these intact — splitting "22.5" would have the
   * synthesiser say "twenty two" and then "five degrees".
   */
  it.each([
    ['It is 22.5 degrees outside right now and rising', '22.'],
    ['Mr. Chen will arrive at about half past four', 'Mr.'],
    ['Ask Dr. Okafor about it tomorrow morning', 'Dr.'],
    ['J. Chen signed off on the change already', 'J.'],
  ])('does not split %j after %j', (reply, fragment) => {
    const chunks = streamThrough(new ClauseChunker({ firstChunkMinChars: 4, minChars: 4 }), reply);
    for (const chunk of chunks) expect(chunk.endsWith(fragment), chunk).toBe(false);
    expect(chunks.join(' ')).toBe(reply);
  });

  it('still breaks on a real sentence end, however short', () => {
    const chunker = new ClauseChunker({ firstChunkMinChars: 40, minChars: 40 });
    expect(chunker.push('Sure. ')).toEqual(['Sure.']);
  });

  it('forces a break at a word boundary once maxChars is exceeded', () => {
    const chunker = new ClauseChunker({ firstChunkMinChars: 10, minChars: 10, maxChars: 40 });
    const runOn = 'word '.repeat(30).trim();
    const chunks = streamThrough(chunker, runOn);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
    expect(chunks.join(' ')).toBe(runOn);
  });

  it('emits nothing for an empty stream', () => {
    const chunker = new ClauseChunker();
    expect(chunker.push('')).toEqual([]);
    expect(chunker.flush()).toBeUndefined();
  });

  it('flushes a short tail rather than swallowing it', () => {
    const chunker = new ClauseChunker({ firstChunkMinChars: 100, minChars: 100 });
    expect(chunker.push('too short')).toEqual([]);
    expect(chunker.flush()).toBe('too short');
  });

  it('trims whitespace off the seams', () => {
    const chunker = new ClauseChunker({ firstChunkMinChars: 4, minChars: 4 });
    for (const chunk of streamThrough(chunker, 'One.   Two.   Three.')) {
      expect(chunk).toBe(chunk.trim());
    }
  });

  it('counts what it has emitted, and resets', () => {
    const chunker = new ClauseChunker({ firstChunkMinChars: 4, minChars: 4 });
    streamThrough(chunker, 'One. Two.');
    expect(chunker.chunksEmitted).toBeGreaterThan(0);
    chunker.reset();
    expect(chunker.chunksEmitted).toBe(0);
    expect(chunker.buffered).toBe('');
  });
});
