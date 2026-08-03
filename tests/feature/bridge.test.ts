import { describe, expect, it } from 'vitest';

import { audio, earcons, firstAt, harness, spoken, states } from './harness.js';

/**
 * The bridge's control flow, driven through a real stub dialog and the three fakes,
 * on virtual time. Criteria 4 and 5 close here.
 */

const REPLY = 'It is sunny and mild in Lisbon today, around twenty two degrees. Enjoy it.';

describe('a turn, end to end', () => {
  it('listens, thinks, speaks, and returns to listening', async () => {
    const h = harness({
      script: [
        { afterMs: 150, text: 'what is', final: false },
        { afterMs: 150, text: 'what is the weather today', final: true },
      ],
      reply: REPLY,
    });
    await h.run();

    expect(states(h.events)).toEqual(['listening', 'thinking', 'speaking', 'listening', 'idle']);
    expect(spoken(h.events)).toBe(REPLY);
    expect(h.tts.requests.map((r) => r.text).join(' ')).toBe(REPLY);
  });

  it('routes the utterance through the dialog, not around it', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
    });
    await h.run();

    // The dialog owns the conversation; the bridge never sees the model.
    expect(h.dialog.history).toEqual([
      { role: 'user', content: 'what is the weather today' },
      { role: 'assistant', content: REPLY },
    ]);
  });

  it('fires earcons on their events, in order', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'hello there', final: true }],
      reply: REPLY,
    });
    await h.run();
    expect(earcons(h.events)).toEqual(['listening', 'accepted', 'ready']);
  });

  it('says nothing when the user says nothing', async () => {
    const h = harness({ script: [], reply: REPLY, micMs: 3_000 });
    await h.run();

    expect(h.llm.calls).toHaveLength(0);
    expect(h.tts.requests).toHaveLength(0);
    expect(states(h.events)).toEqual(['listening', 'idle']);
  });
});

describe('endpointing (criterion 4)', () => {
  /** "a partial, a short gap, then more speech — the assistant waits". */
  it('waits through a mid-sentence pause rather than cutting in', async () => {
    const h = harness({
      script: [
        { afterMs: 200, text: 'book me a table for', final: false },
        { afterMs: 400, text: 'book me a table for four', final: false },
      ],
      reply: REPLY,
      endOfTurnMs: 700,
      pauseMs: 300,
    });
    await h.run();

    // A detector that failed to re-arm would end the turn at 900 — 700ms after the
    // *first* partial — cutting the user off mid-sentence.
    const thinkingAt = h.events.find(
      (e) => e.event.type === 'state' && e.event.state === 'thinking',
    )?.at;
    expect(thinkingAt).toBe(1_300);

    expect(h.dialog.history[0]).toEqual({
      role: 'user',
      content: 'book me a table for four',
    });
  });

  it('reports hesitations without acting on them', async () => {
    const h = harness({
      script: [
        { afterMs: 200, text: 'book me a table for', final: false },
        { afterMs: 400, text: 'book me a table for four', final: false },
      ],
      reply: REPLY,
      endOfTurnMs: 700,
      pauseMs: 300,
    });
    await h.run();

    const pauses = h.events.filter((e) => e.event.type === 'pause_detected').map((e) => e.at);
    expect(pauses).toEqual([500, 900]);
  });

  it('responds promptly once the user has genuinely stopped', async () => {
    const h = harness({
      script: [{ afterMs: 200, text: 'what is the weather', final: false }],
      reply: REPLY,
      endOfTurnMs: 700,
    });
    await h.run();

    const thinkingAt = h.events.find(
      (e) => e.event.type === 'state' && e.event.state === 'thinking',
    )?.at;
    expect(thinkingAt).toBe(900);
  });
});

describe('streaming both ways (criterion 5)', () => {
  it('starts speaking before the model has finished generating', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
      ttftMs: 100,
      interTokenMs: 40,
    });
    await h.run();

    const firstAudioAt = firstAt(h.events, 'audio');
    expect(firstAudioAt).toBeDefined();

    // The dialog hands over clause by clause, so synthesis of the first overlaps
    // generation of the rest. More than one synthesis call proves the split.
    expect(h.tts.requests.length).toBeGreaterThan(1);
    expect(h.tts.requests.every((r) => r.completed)).toBe(true);
  });

  it('streams the user transcript incrementally', async () => {
    const h = harness({
      script: [
        { afterMs: 150, text: 'what', final: false },
        { afterMs: 150, text: 'what is', final: false },
        { afterMs: 150, text: 'what is the', final: false },
        { afterMs: 150, text: 'what is the weather', final: true },
      ],
      reply: REPLY,
    });
    await h.run();

    const transcripts = h.events.filter((e) => e.event.type === 'transcript');
    expect(transcripts.map((t) => (t.event as { text: string }).text)).toEqual([
      'what',
      'what is',
      'what is the',
      'what is the weather',
    ]);

    // Distinct arrival times — the definition of incremental.
    const times = transcripts.map((t) => t.at);
    expect(new Set(times).size).toBe(4);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('streams the assistant transcript as clauses are settled', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'hello', final: true }],
      reply: REPLY,
    });
    await h.run();

    const deltas = h.events.filter((e) => e.event.type === 'assistant_text');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.at(-1)!.at).toBeGreaterThan(deltas[0]!.at);
    expect(spoken(h.events)).toBe(REPLY);
  });

  it('emits audio throughout, not in one burst at the end', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'hello', final: true }],
      reply: REPLY,
    });
    await h.run();

    const frames = audio(h.events);
    expect(frames.length).toBeGreaterThan(20);
    expect(frames.at(-1)!.at - frames[0]!.at).toBeGreaterThan(1_000);
  });
});
