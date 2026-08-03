import { describe, expect, it } from 'vitest';

import { audio, harness, states } from './harness.js';
import type { Harness, Stamped } from './harness.js';

/**
 * Criteria 1, 2 and 3 — barge-in, resume, and fresh turn.
 *
 * This tier proves control flow. It cannot prove *latency*: whether a human hears
 * silence within 300ms is a question only a real browser answers, and it is answered
 * by `pnpm bench:latency`. Both are required; neither substitutes for the other.
 */

const REPLY =
  'It is sunny and mild in Lisbon today, around twenty two degrees. ' +
  'The afternoon should stay clear, with a light breeze from the west. ' +
  'You will not need a coat at all.';

/** Interrupt after `cutAfter` audio frames, then say `then` two seconds later. */
function interruptedBy(then: string | undefined, cutAfter = 6): Harness {
  let frames = 0;
  const script = [{ afterMs: 150, text: 'what is the weather today', final: true }];
  if (then !== undefined) script.push({ afterMs: 2_500, text: then, final: true });

  return harness({
    script,
    reply: REPLY,
    micMs: 14_000,
    onEvent: (event, { bridge, clock }) => {
      if (event.type !== 'audio') return;
      frames += 1;
      if (frames === cutAfter) bridge.interrupt(clock.now());
    },
  });
}

const framesBefore = (events: Stamped[]): number => {
  const at = events.find((e) => e.event.type === 'interrupted')?.at;
  return at === undefined ? 0 : audio(events).filter((f) => f.at <= at).length;
};

describe('barge-in stops immediately (criterion 1)', () => {
  it('stops emitting on the next chunk, not at the end of the sentence', async () => {
    const h = interruptedBy(undefined);
    await h.run();

    expect(framesBefore(h.events)).toBe(6);

    const cut = h.tts.requests.find((r) => !r.completed);
    expect(cut, 'the in-flight synthesis was abandoned mid-stream').toBeDefined();
    expect(cut!.framesEmitted).toBeLessThan(cut!.totalFrames);
  });

  it('returns to listening at once', async () => {
    const h = interruptedBy(undefined);
    await h.run();
    expect(states(h.events).slice(0, 4)).toEqual([
      'listening',
      'thinking',
      'speaking',
      'listening',
    ]);
  });

  it('ignores an interrupt when the assistant is not talking', async () => {
    const h = harness({ script: [], reply: REPLY, micMs: 1_000 });
    h.bridge.interrupt(0);
    await h.run();
    expect(h.warnings.some((w) => w.includes('interrupt ignored'))).toBe(true);
  });
});

describe('resume an interrupted reply (criterion 2)', () => {
  it('continues from where the user stopped hearing it, not from the start', async () => {
    const h = interruptedBy('keep going');
    await h.run();

    expect(h.dialog.lastIntent).toBe('resume');

    const interrupted = h.events.find((e) => e.event.type === 'interrupted');
    const resumed = h.events.find((e) => e.event.type === 'resumed');
    expect(interrupted).toBeDefined();
    expect(resumed).toBeDefined();

    const heardAt = (interrupted!.event as { spokenChars: number }).spokenChars;
    const { from, remaining } = resumed!.event as { from: number; remaining: string };

    // Resumes from the heard offset — not from zero, and not from the generation cursor.
    expect(from).toBe(heardAt);
    expect(from).toBeGreaterThan(0);

    // The remainder is a proper suffix: nothing repeated, nothing skipped.
    expect(REPLY.endsWith(remaining)).toBe(true);
    expect(REPLY.slice(0, from) + remaining).toBe(REPLY);
  });

  it('does not restart the reply', async () => {
    const h = interruptedBy('keep going');
    await h.run();

    const resumed = h.events.find((e) => e.event.type === 'resumed')!;
    const { remaining } = resumed.event as { remaining: string };

    expect(remaining).not.toBe(REPLY);
    expect(remaining.startsWith('It is sunny')).toBe(false);

    // The synthesis after the resume begins mid-reply, not at the opening words.
    const resumedRequests = h.tts.requests.filter((r) => remaining.startsWith(r.text));
    expect(resumedRequests.length).toBeGreaterThan(0);
  });

  it('speaks again after resuming', async () => {
    const h = interruptedBy('keep going');
    await h.run();

    const resumedAt = h.events.find((e) => e.event.type === 'resumed')!.at;
    expect(audio(h.events).some((f) => f.at > resumedAt)).toBe(true);
  });

  it('treats a backchannel as permission to carry on', async () => {
    const h = interruptedBy('mhm');
    await h.run();

    expect(h.dialog.lastIntent).toBe('backchannel');
    expect(h.events.some((e) => e.event.type === 'resumed')).toBe(true);
  });

  /** "Hold on" holds. The reply stays parked and nothing is spoken. */
  it('stays silent on hold on', async () => {
    const h = interruptedBy('hold on');
    await h.run();

    expect(h.dialog.lastIntent).toBe('pause');
    expect(h.events.some((e) => e.event.type === 'resumed')).toBe(false);
    expect(h.bridge.paused).toBe(true);

    const interruptedAt = h.events.find((e) => e.event.type === 'interrupted')!.at;
    expect(audio(h.events).every((f) => f.at <= interruptedAt)).toBe(true);
  });
});

describe('fresh turn after interruption (criterion 3)', () => {
  it('abandons the prior reply and answers the new question', async () => {
    const h = interruptedBy('tell me about Porto instead');
    await h.run();

    expect(h.dialog.lastIntent).toBeUndefined(); // fell through to a fresh reply
    expect(h.events.some((e) => e.event.type === 'resumed')).toBe(false);
    expect(h.llm.calls).toHaveLength(2);
    expect(h.dialog.history.map((m) => m.content)).toContain('tell me about Porto instead');
  });

  it('speaks the new reply from its beginning', async () => {
    const h = interruptedBy('tell me about Porto instead');
    await h.run();

    const interruptedAt = h.events.find((e) => e.event.type === 'interrupted')!.at;
    const after = h.tts.requests.filter((r) => r.completed && REPLY.startsWith(r.text));

    // The new reply starts at the top — it is a different answer, not a continuation.
    expect(after.length).toBeGreaterThan(0);
    expect(audio(h.events).some((f) => f.at > interruptedAt)).toBe(true);
  });

  it('drops the reply entirely on cancel', async () => {
    const h = interruptedBy('never mind');
    await h.run();

    expect(h.dialog.lastIntent).toBe('cancel');
    expect(h.events.some((e) => e.event.type === 'resumed')).toBe(false);
    expect(h.llm.calls).toHaveLength(1);

    const interruptedAt = h.events.find((e) => e.event.type === 'interrupted')!.at;
    expect(audio(h.events).every((f) => f.at <= interruptedAt)).toBe(true);
  });
});
