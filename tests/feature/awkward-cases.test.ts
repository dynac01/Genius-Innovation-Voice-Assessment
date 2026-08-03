import { describe, expect, it } from 'vitest';

import { audio, earcons, harness, states } from './harness.js';

/**
 * Criterion 8 — the three awkward cases, in the brief's own words:
 *
 *   "Sustained silence does not trigger a spurious response; the user and
 *    assistant starting at the same instant resolves without a deadlock or both
 *    talking over each other; a provider hiccup mid-reply surfaces a failed
 *    earcon rather than hanging."
 *
 * The simultaneous-start case is split across tiers on purpose. The *decision* is
 * pure and exhaustively tested in `start-race.test.ts` — every ordering, every
 * repetition. What this file adds is the loop's half: that an interruption
 * arriving in either turn state resolves rather than wedging.
 */

const REPLY = 'It is sunny and mild in Lisbon today, around twenty two degrees. Enjoy it.';

describe('sustained silence', () => {
  it('produces no response when nothing is ever said', async () => {
    const h = harness({ script: [], reply: REPLY, micMs: 10_000 });
    await h.run();

    expect(h.llm.calls).toHaveLength(0);
    expect(h.tts.requests).toHaveLength(0);
    expect(audio(h.events)).toHaveLength(0);
    expect(states(h.events)).toEqual(['listening', 'idle']);
  });

  /**
   * The subtler version: the provider is talking to us, but has nothing to
   * report. Treating an empty transcript as speech would hold the turn open and
   * then answer a question nobody asked.
   */
  it('ignores empty transcripts from a chatty provider', async () => {
    const h = harness({
      script: [
        { afterMs: 500, text: '', final: false },
        { afterMs: 500, text: '   ', final: false },
        { afterMs: 500, text: '', final: false },
        { afterMs: 500, text: '\n', final: false },
      ],
      reply: REPLY,
      micMs: 10_000,
    });
    await h.run();

    expect(h.llm.calls).toHaveLength(0);
    expect(earcons(h.events)).toEqual(['listening']);
  });

  it('still answers once real speech finally arrives', async () => {
    const h = harness({
      script: [
        { afterMs: 2_000, text: '', final: false },
        { afterMs: 2_000, text: 'are you there', final: true },
      ],
      reply: REPLY,
      micMs: 12_000,
    });
    await h.run();

    expect(h.llm.calls).toHaveLength(1);
    expect(h.dialog.history[0]).toEqual({ role: 'user', content: 'are you there' });
  });
});

describe('simultaneous start', () => {
  /** Interrupting while the assistant is still generating, before any audio. */
  it('resolves an interrupt that lands during thinking', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
      micMs: 8_000,
      onEvent: (event, { bridge, clock }) => {
        if (event.type === 'state' && event.state === 'thinking') bridge.interrupt(clock.now());
      },
    });
    await h.run();

    // Resolved, not wedged: back to listening, and the session ends cleanly.
    expect(states(h.events)).toContain('listening');
    expect(h.bridge.state).toBe('idle');
    expect(h.warnings.filter((w) => w.includes('rejected'))).toEqual([]);
  });

  /**
   * The contested reply is abandoned rather than resumed. Audio *after* the
   * interrupt is not a violation — it belongs to whatever the dialog decided to
   * say next, which is the point of asking. What must not happen is the old reply
   * continuing.
   */
  it('abandons the contested reply rather than resuming it', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
      micMs: 8_000,
      onEvent: (event, { bridge, clock }) => {
        if (event.type === 'state' && event.state === 'thinking') bridge.interrupt(clock.now());
      },
    });
    await h.run();

    const interrupted = h.events.find((e) => e.event.type === 'interrupted');
    expect(interrupted).toBeDefined();

    // Nothing had been heard when the contest was resolved, so there is nothing to
    // resume — and the loop must not pretend otherwise.
    expect((interrupted!.event as { spokenChars: number }).spokenChars).toBe(0);
    expect(h.events.some((e) => e.event.type === 'resumed')).toBe(false);

    // The contest collapses to a single clean reply rather than two half-replies
    // or none. Note the ordering this depends on: the bridge reaches `thinking`
    // when it endpoints, which is before the dialog has seen the utterance — so
    // an interrupt at that instant contests a turn that has not started
    // generating yet, and the dialog simply treats the utterance as a fresh one.
    expect(h.llm.calls).toHaveLength(1);
    expect(h.llm.calls[0]?.completed).toBe(true);
  });

  it('recovers and answers the next turn normally', async () => {
    const h = harness({
      script: [
        { afterMs: 150, text: 'first question', final: true },
        { afterMs: 4_000, text: 'second question', final: true },
      ],
      reply: REPLY,
      micMs: 16_000,
      onEvent: (event, { bridge, clock }) => {
        if (event.type === 'state' && event.state === 'thinking' && h.llm.calls.length === 1) {
          bridge.interrupt(clock.now());
        }
      },
    });
    await h.run();

    expect(h.llm.calls).toHaveLength(2);
    expect(h.llm.calls[1]?.completed).toBe(true);
    expect(h.bridge.state).toBe('idle');
  });
});

describe('provider hiccup mid-reply', () => {
  it('surfaces a failed earcon when the provider errors', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
      failAfterTokens: 3,
      micMs: 8_000,
    });
    await h.run();

    expect(earcons(h.events)).toContain('failed');
    expect(h.bridge.state).toBe('idle');
  });

  /**
   * The harder half: the provider does not error, it simply stops. Without an idle
   * budget the loop waits forever and the user sees an assistant that has nothing
   * to say — a failure with no error anywhere to notice.
   */
  it('surfaces a failed earcon when the provider goes silent', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
      stallAfterTokens: 3,
      llmIdleTimeoutMs: 800,
      micMs: 12_000,
    });
    await h.run();

    expect(earcons(h.events)).toContain('failed');
    expect(h.bridge.state).toBe('idle');
  });

  /**
   * The user hears a failed earcon; the operator gets the reason. The fixed
   * `ToBridge` protocol has no error message — `say`, `earcon`, `barge_in` and
   * nothing else — so a dialog cannot report *why* over the wire. That is a real
   * constraint of the protocol rather than an oversight, and the split is the
   * right one anyway: "something went wrong" is what the user needs, and
   * "llm sent nothing for 500ms" is what an operator needs.
   */
  it('names the stalled provider for the operator', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
      stallAfterTokens: 2,
      llmIdleTimeoutMs: 500,
      micMs: 12_000,
    });
    await h.run();

    expect(earcons(h.events)).toContain('failed');
    expect(h.warnings.some((w) => /llm sent nothing for 500ms/.test(w))).toBe(true);
  });

  it('keeps taking turns after a hiccup', async () => {
    const h = harness({
      script: [
        { afterMs: 150, text: 'first question', final: true },
        { afterMs: 4_000, text: 'second question', final: true },
      ],
      reply: REPLY,
      failAfterTokens: 2,
      micMs: 16_000,
    });
    await h.run();

    // Both turns were attempted — a hiccup ends a reply, not the session.
    expect(h.llm.calls).toHaveLength(2);
    expect(earcons(h.events).filter((e) => e === 'failed')).toHaveLength(2);
    expect(h.bridge.state).toBe('idle');
  });
});

/**
 * A synthesis failure must end a reply, not the ability to speak.
 *
 * This came from a real session. Several turns worked, then Deepgram's TTS socket
 * went quiet, the idle budget fired, and from that moment the assistant never made
 * another sound — while the transcript kept updating, turns kept being taken, and
 * the socket stayed open. It looked like the voice had been switched off.
 *
 * The cause is a shape that reads as correct: synthesis runs in one long-lived loop
 * over the speech queue, and errors were handled by attaching `.catch()` to that
 * loop's promise. The catch reports the failure honestly — failed earcon, error
 * event, turn returned to a usable state — and by the time it runs the `for await`
 * has already unwound. There is nothing left to speak with.
 *
 * The hiccup tests that existed all failed the *model*, which the loop survives
 * because the failure happens upstream of it. Nothing failed the synthesiser, so
 * nothing noticed that one is recoverable and the other was terminal.
 */
describe('synthesis hiccup mid-reply', () => {
  it('recovers: a later turn still produces audio', async () => {
    const h = harness({
      script: [
        { afterMs: 150, text: 'first question', final: true },
        { afterMs: 6_000, text: 'second question', final: true },
      ],
      reply: REPLY,
      failSynthesisCalls: 1,
      micMs: 18_000,
    });
    await h.run();

    const audio = h.events.filter(({ event }) => event.type === 'audio');
    expect(audio.length, 'nothing was ever spoken again after one failed clause').toBeGreaterThan(
      0,
    );
  });

  it('reports the failure rather than swallowing it', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'first question', final: true }],
      reply: REPLY,
      failSynthesisCalls: 1,
      micMs: 8_000,
    });
    await h.run();

    expect(earcons(h.events)).toContain('failed');
  });

  it('ends the turn cleanly instead of parking in speaking', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'first question', final: true }],
      reply: REPLY,
      failSynthesisCalls: 1,
      micMs: 8_000,
    });
    await h.run();

    // A loop stuck in `speaking` refuses the next turn's transitions, which is how
    // a single failure turns into a session that no longer responds at all.
    expect(h.bridge.state).toBe('idle');
  });
});
