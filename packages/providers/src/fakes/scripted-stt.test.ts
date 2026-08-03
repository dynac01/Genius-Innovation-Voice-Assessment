import { VirtualClock } from '@voice/core';
import { describe, expect, it } from 'vitest';

import { fakeMicrophone } from './audio-source.js';
import { ScriptedStt } from './scripted-stt.js';

interface Seen {
  text: string;
  final: boolean;
  at: number;
}

async function drive(stt: ScriptedStt, clock: VirtualClock, micMs = 2_000): Promise<Seen[]> {
  const seen: Seen[] = [];
  const consuming = (async () => {
    for await (const result of stt.transcribeStream(fakeMicrophone({ clock, durationMs: micMs }))) {
      seen.push({ ...result, at: clock.now() });
    }
  })();
  await clock.runUntilIdle();
  await consuming;
  return seen;
}

describe('ScriptedStt', () => {
  it('emits each step at its scripted time', async () => {
    const clock = new VirtualClock();
    const stt = new ScriptedStt({
      clock,
      script: [
        { afterMs: 100, text: 'what is', final: false },
        { afterMs: 150, text: 'what is the weather', final: false },
        { afterMs: 200, text: 'what is the weather today', final: true },
      ],
    });

    expect(await drive(stt, clock)).toEqual([
      { text: 'what is', final: false, at: 100 },
      { text: 'what is the weather', final: false, at: 250 },
      { text: 'what is the weather today', final: true, at: 450 },
    ]);
  });

  /**
   * Criterion 4's shape, expressible only because the script carries timing: a
   * partial, a gap long enough to look like end-of-turn, then more speech.
   */
  it('can express a mid-sentence pause followed by more speech', async () => {
    const clock = new VirtualClock();
    const stt = new ScriptedStt({
      clock,
      script: [
        { afterMs: 200, text: 'book me a table for', final: false },
        { afterMs: 400, text: 'book me a table for four', final: false },
        { afterMs: 300, text: 'book me a table for four people', final: true },
      ],
    });

    const seen = await drive(stt, clock);
    const gap = seen[1]!.at - seen[0]!.at;
    expect(gap).toBe(400);
    expect(seen.at(-1)).toMatchObject({ final: true });
  });

  it('consumes the audio it is given rather than ignoring the stream', async () => {
    const clock = new VirtualClock();
    const stt = new ScriptedStt({ clock, script: [{ afterMs: 100, text: 'hi', final: true }] });

    await drive(stt, clock, 500);

    expect(stt.consumed.length).toBeGreaterThan(0);
    expect(stt.consumed[0]).toMatchObject({ sampleRate: 16_000 });
  });

  it('produces nothing for an empty script', async () => {
    const clock = new VirtualClock();
    const stt = new ScriptedStt({ clock, script: [] });
    expect(await drive(stt, clock, 200)).toEqual([]);
  });
});
