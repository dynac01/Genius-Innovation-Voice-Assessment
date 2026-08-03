import { VirtualClock, VoiceLoop } from '@voice/core';
import type { LLM, LoopEvent, Message, Pipeline } from '@voice/core';
import { CannedLlm, ScriptedStt, SilentTts, fakeMicrophone } from '@voice/providers';
import { describe, expect, it } from 'vitest';

import type { SttScriptStep } from '@voice/providers';

/**
 * The loop's control flow, driven through the fakes on virtual time.
 *
 * Criteria 4 and 5 close here. No audio device, no API key, no wall clock — a test
 * asserting the assistant waits through a 400ms pause takes microseconds, and
 * cannot flake because a CI runner stalled.
 */

const REPLY = 'It is sunny and mild in Lisbon today, around twenty two degrees. Enjoy it.';

interface Stamped {
  event: LoopEvent;
  at: number;
}

interface Harness {
  events: Stamped[];
  llm: CannedLlm;
  tts: SilentTts;
  llmFinishedAt: () => number | undefined;
  run: () => Promise<void>;
}

function harness(options: {
  script: SttScriptStep[];
  micMs?: number;
  endOfTurnMs?: number;
  pauseMs?: number;
  ttftMs?: number;
  interTokenMs?: number;
}): Harness {
  const clock = new VirtualClock();
  const events: Stamped[] = [];

  const stt = new ScriptedStt({ clock, script: options.script });
  const canned = new CannedLlm({
    clock,
    reply: REPLY,
    ttftMs: options.ttftMs ?? 100,
    interTokenMs: options.interTokenMs ?? 30,
  });
  const tts = new SilentTts({ clock, ttfbMs: 40, frameMs: 20 });

  // A decorator over the real fake, implementing the same interface. It records when
  // generation finished — which is how criterion 5 is checked — and doubles as a
  // demonstration that the LLM seam takes an arbitrary implementation.
  let llmFinishedAt: number | undefined;
  const llm: LLM = {
    async *respond(messages: Message[]) {
      yield* canned.respond(messages);
      llmFinishedAt = clock.now();
    },
  };

  const pipeline: Pipeline = { stt, llm, tts };
  const loop = new VoiceLoop({
    pipeline,
    clock,
    endpointer: {
      endOfTurnMs: options.endOfTurnMs ?? 700,
      pauseMs: options.pauseMs ?? 300,
      trustSttFinal: true,
    },
    onEvent: (event) => events.push({ event, at: clock.now() }),
  });

  return {
    events,
    llm: canned,
    tts,
    llmFinishedAt: () => llmFinishedAt,
    run: async () => {
      const running = loop.run(fakeMicrophone({ clock, durationMs: options.micMs ?? 4_000 }));
      await clock.runUntilIdle();
      await running;
    },
  };
}

const at = (events: Stamped[], type: LoopEvent['type']): number | undefined =>
  events.find((e) => e.event.type === type)?.at;

const states = (events: Stamped[]): string[] =>
  events.filter((e) => e.event.type === 'state').map((e) => (e.event as { state: string }).state);

describe('the loop, end to end on fakes', () => {
  it('completes a turn: listen, think, speak, listen', async () => {
    const h = harness({
      script: [
        { afterMs: 150, text: 'what is', final: false },
        { afterMs: 150, text: 'what is the weather today', final: true },
      ],
    });
    await h.run();

    expect(states(h.events)).toEqual(['listening', 'thinking', 'speaking', 'listening', 'idle']);
    expect(h.llm.lastCall?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'what is the weather today',
    });
    expect(h.tts.requests.map((r) => r.text).join(' ')).toBe(REPLY);
  });

  it('fires earcons on their events, in order', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'hello there', final: true }],
    });
    await h.run();

    const sounds = h.events
      .filter((e) => e.event.type === 'earcon')
      .map((e) => (e.event as { sound: string }).sound);
    expect(sounds).toEqual(['listening', 'accepted', 'ready']);
  });

  /**
   * Criterion 4, as the brief words it: "a partial, a short gap, then more speech —
   * the assistant waits". The gap is 400ms, longer than the pause threshold and
   * shorter than the end-of-turn window.
   */
  it('waits through a mid-sentence pause rather than cutting in', async () => {
    const h = harness({
      script: [
        { afterMs: 200, text: 'book me a table for', final: false },
        { afterMs: 400, text: 'book me a table for four', final: false },
      ],
      endOfTurnMs: 700,
      pauseMs: 300,
    });
    await h.run();

    // A detector that failed to re-arm would end the turn 700ms after the *first*
    // partial — at 900 — cutting the user off mid-sentence.
    const thinkingAt = h.events.find(
      (e) => e.event.type === 'state' && e.event.state === 'thinking',
    )?.at;
    expect(thinkingAt).toBe(1_300);

    // Both hesitations were reported and neither ended the turn: 500 is 300ms after
    // the first partial, 900 is 300ms after the user resumed. Reporting a pause is
    // information for the dialog, not a decision to respond.
    const pauses = h.events.filter((e) => e.event.type === 'pause_detected').map((e) => e.at);
    expect(pauses).toEqual([500, 900]);

    // And the model saw the complete utterance, not the truncated first partial.
    expect(h.llm.lastCall?.messages.at(-1)?.content).toBe('book me a table for four');
  });

  it('responds promptly once the user has genuinely stopped', async () => {
    const h = harness({
      script: [{ afterMs: 200, text: 'what is the weather', final: false }],
      endOfTurnMs: 700,
    });
    await h.run();

    const thinkingAt = h.events.find(
      (e) => e.event.type === 'state' && e.event.state === 'thinking',
    )?.at;
    // Speech ended at 200; the stated window is 700.
    expect(thinkingAt).toBe(900);
  });

  /**
   * Criterion 5, first half: the assistant starts speaking before the reply has
   * finished generating. If the loop serialised the model and the synthesiser this
   * would be false by construction, and every turn would carry the full generation
   * time as silence.
   */
  it('starts speaking before the model has finished generating', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      ttftMs: 100,
      interTokenMs: 40,
    });
    await h.run();

    const firstAudioAt = at(h.events, 'audio');
    const finishedAt = h.llmFinishedAt();

    expect(firstAudioAt).toBeDefined();
    expect(finishedAt).toBeDefined();
    expect(firstAudioAt!).toBeLessThan(finishedAt!);

    // More than a rounding error: real overlap, not a coincidence of ordering.
    expect(finishedAt! - firstAudioAt!).toBeGreaterThan(100);
  });

  it('hands TTS its first chunk while later chunks are still being generated', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
    });
    await h.run();

    // Several chunks, not one lump handed over at the end.
    expect(h.tts.requests.length).toBeGreaterThan(1);
    expect(h.tts.requests.every((r) => r.completed)).toBe(true);
  });

  /**
   * Criterion 5, second half: the transcript updates as partials arrive rather than
   * appearing all at once at the end.
   */
  it('streams the user transcript incrementally', async () => {
    const h = harness({
      script: [
        { afterMs: 150, text: 'what', final: false },
        { afterMs: 150, text: 'what is', final: false },
        { afterMs: 150, text: 'what is the', final: false },
        { afterMs: 150, text: 'what is the weather', final: true },
      ],
    });
    await h.run();

    const transcripts = h.events.filter((e) => e.event.type === 'transcript');
    expect(transcripts).toHaveLength(4);

    // Each arrived at a distinct time — the definition of incremental.
    const times = transcripts.map((t) => t.at);
    expect(new Set(times).size).toBe(4);
    expect(times).toEqual([...times].sort((a, b) => a - b));

    expect(transcripts.map((t) => (t.event as { text: string }).text)).toEqual([
      'what',
      'what is',
      'what is the',
      'what is the weather',
    ]);
  });

  it('streams the assistant transcript as the reply is generated', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'hello', final: true }],
    });
    await h.run();

    const deltas = h.events.filter((e) => e.event.type === 'assistant_text');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => (d.event as { text: string }).text).join('')).toBe(REPLY);

    // The first delta lands well before the last — it is a stream, not a batch.
    expect(deltas.at(-1)!.at).toBeGreaterThan(deltas[0]!.at);
  });

  it('handles two turns in a row', async () => {
    const h = harness({
      script: [
        { afterMs: 150, text: 'first question', final: true },
        { afterMs: 2_000, text: 'second question', final: true },
      ],
      micMs: 8_000,
    });
    await h.run();

    expect(h.llm.calls).toHaveLength(2);
    expect(h.llm.calls[1]?.messages.map((m) => m.content)).toEqual([
      'first question',
      REPLY,
      'second question',
    ]);
  });

  it('says nothing when the user says nothing', async () => {
    const h = harness({ script: [], micMs: 3_000 });
    await h.run();

    expect(h.llm.calls).toHaveLength(0);
    expect(h.tts.requests).toHaveLength(0);
    expect(states(h.events)).toEqual(['listening', 'idle']);
  });
});
