import { VirtualClock, VoiceLoop } from '@voice/core';
import type { LoopEvent } from '@voice/core';
import { CannedLlm, ScriptedStt, SilentTts, fakeMicrophone } from '@voice/providers';
import { describe, expect, it } from 'vitest';

/**
 * Criterion 1, the one weighted hardest: an `interrupt` stops TTS emission **on the
 * next chunk**, not after the current sentence finishes.
 *
 * This tier proves the control flow. It cannot prove the *latency* — whether a human
 * hears silence within 300ms is a question only a real browser can answer, and it is
 * answered by the latency harness and the recorded demo. Both are required; neither
 * substitutes for the other. See docs/TESTING.md §6.
 */

const REPLY =
  'It is sunny and mild in Lisbon today, around twenty two degrees. ' +
  'The afternoon should stay clear, with a light breeze from the west. ' +
  'You will not need a coat.';

interface Stamped {
  event: LoopEvent;
  at: number;
}

/** Runs a turn, calling `interrupt` after `stopAfterFrames` of assistant audio. */
async function turnInterruptedAfter(stopAfterFrames: number | undefined): Promise<{
  events: Stamped[];
  loop: VoiceLoop;
  tts: SilentTts;
  llm: CannedLlm;
  clock: VirtualClock;
}> {
  const clock = new VirtualClock();
  const events: Stamped[] = [];

  const stt = new ScriptedStt({
    clock,
    script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
  });
  const llm = new CannedLlm({ clock, reply: REPLY, ttftMs: 100, interTokenMs: 25 });
  const tts = new SilentTts({ clock, ttfbMs: 40, frameMs: 20 });

  let audioFrames = 0;
  const loop: VoiceLoop = new VoiceLoop({
    pipeline: { stt, llm, tts },
    clock,
    onEvent: (event) => {
      events.push({ event, at: clock.now() });
      if (event.type !== 'audio' || stopAfterFrames === undefined) return;
      audioFrames += 1;
      if (audioFrames === stopAfterFrames) loop.interrupt(clock.now());
    },
  });

  const running = loop.run(fakeMicrophone({ clock, durationMs: 12_000 }));
  await clock.runUntilIdle();
  await running;

  return { events, loop, tts, llm, clock };
}

const audioFrames = (events: Stamped[]): Stamped[] =>
  events.filter((e) => e.event.type === 'audio');

describe('barge-in', () => {
  it('stops emitting audio on the next chunk, not at the end of the sentence', async () => {
    const { events, tts } = await turnInterruptedAfter(6);

    // Exactly the frames emitted before the interrupt, and not one more. A loop that
    // finished the current synthesis call would emit the rest of that sentence.
    expect(audioFrames(events)).toHaveLength(6);

    const cut = tts.requests.find((r) => !r.completed);
    expect(cut, 'the in-flight synthesis was abandoned mid-stream').toBeDefined();
    expect(cut!.framesEmitted).toBeLessThan(cut!.totalFrames);
  });

  it('emits no audio at all after the interrupt', async () => {
    const { events } = await turnInterruptedAfter(4);

    const interruptedAt = events.find((e) => e.event.type === 'interrupted')?.at;
    expect(interruptedAt).toBeDefined();

    for (const frame of audioFrames(events)) {
      expect(frame.at).toBeLessThanOrEqual(interruptedAt!);
    }
  });

  it('returns to listening immediately', async () => {
    const { events } = await turnInterruptedAfter(5);

    const states = events
      .filter((e) => e.event.type === 'state')
      .map((e) => (e.event as { state: string }).state);
    expect(states).toEqual(['listening', 'thinking', 'speaking', 'listening', 'idle']);
  });

  /**
   * Abandoning generation matters as much as abandoning playback: continuing to pay
   * for tokens nobody will hear is the same mistake as a late stop, just invisible.
   */
  it('abandons generation, not just playback', async () => {
    const { llm } = await turnInterruptedAfter(5);

    expect(llm.lastCall?.completed).toBe(false);
    expect(llm.lastCall!.textEmitted.length).toBeLessThan(REPLY.length);
  });

  /**
   * The resume point criterion 2 will need. It must index what was *heard*, which
   * is strictly behind what was generated — the model runs ahead of the synthesiser,
   * which runs ahead of the playhead.
   */
  it('records what the user actually heard, not what was generated', async () => {
    const { loop, llm } = await turnInterruptedAfter(6);
    const interrupted = loop.interrupted;

    expect(interrupted).toBeDefined();
    expect(interrupted!.spokenChars).toBeGreaterThan(0);

    const heard = interrupted!.reply.slice(0, interrupted!.spokenChars);
    const remaining = interrupted!.reply.slice(interrupted!.spokenChars);

    expect(REPLY.startsWith(heard)).toBe(true);
    expect(remaining.length).toBeGreaterThan(0);
    expect(heard + remaining).toBe(interrupted!.reply);

    // Heard is behind generated, which is behind the full reply.
    expect(interrupted!.spokenChars).toBeLessThanOrEqual(llm.lastCall!.textEmitted.length);
    expect(interrupted!.spokenChars).toBeLessThan(REPLY.length);
  });

  it('leaves an uninterrupted turn untouched', async () => {
    const { events, loop, tts, llm } = await turnInterruptedAfter(undefined);

    expect(loop.interrupted).toBeUndefined();
    expect(llm.lastCall?.completed).toBe(true);
    expect(tts.requests.every((r) => r.completed)).toBe(true);
    expect(audioFrames(events).length).toBeGreaterThan(20);
    expect(events.some((e) => e.event.type === 'interrupted')).toBe(false);
  });

  it('ignores an interrupt when the assistant is not talking', async () => {
    const clock = new VirtualClock();
    const warnings: string[] = [];
    const loop = new VoiceLoop({
      pipeline: {
        stt: new ScriptedStt({ clock, script: [] }),
        llm: new CannedLlm({ clock, reply: REPLY }),
        tts: new SilentTts({ clock }),
      },
      clock,
      onEvent: () => undefined,
      onWarning: (message) => warnings.push(message),
    });

    const running = loop.run(fakeMicrophone({ clock, durationMs: 500 }));
    loop.interrupt(0);
    await clock.runUntilIdle();
    await running;

    // A barge-in against a machine that is not talking is a bug worth surfacing,
    // not a no-op to absorb quietly.
    expect(warnings.some((w) => w.includes('interrupt ignored'))).toBe(true);
    expect(loop.interrupted).toBeUndefined();
  });

  it('carries on with the next turn after an interruption', async () => {
    const clock = new VirtualClock();
    const events: Stamped[] = [];

    const stt = new ScriptedStt({
      clock,
      script: [
        { afterMs: 150, text: 'first question', final: true },
        { afterMs: 3_000, text: 'second question', final: true },
      ],
    });
    const llm = new CannedLlm({ clock, reply: REPLY, ttftMs: 100, interTokenMs: 25 });
    const tts = new SilentTts({ clock, ttfbMs: 40, frameMs: 20 });

    let frames = 0;
    const loop: VoiceLoop = new VoiceLoop({
      pipeline: { stt, llm, tts },
      clock,
      onEvent: (event) => {
        events.push({ event, at: clock.now() });
        if (event.type === 'audio') {
          frames += 1;
          if (frames === 5) loop.interrupt(clock.now());
        }
      },
    });

    const running = loop.run(fakeMicrophone({ clock, durationMs: 15_000 }));
    await clock.runUntilIdle();
    await running;

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]?.completed).toBe(false);
    expect(llm.calls[1]?.completed).toBe(true);
  });
});
