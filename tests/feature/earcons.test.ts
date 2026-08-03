import { describe, expect, it } from 'vitest';

import { audio, earcons, harness } from './harness.js';

/**
 * Criterion 6 — earcons at the right moments, non-clobbering.
 *
 * This tier proves *when* each sound fires. That it does not clobber speech is not
 * asserted here because it is not a runtime property: earcons are mixed on their own
 * node, parallel to the speech gain, so interference is structurally impossible
 * rather than avoided by timing. See apps/web/src/audio/earcons.ts.
 */

const REPLY = 'It is sunny and mild in Lisbon today, around twenty two degrees. Enjoy it.';

describe('earcons', () => {
  it('plays the listening tone when capture starts, before anything else', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'hello there', final: true }],
      reply: REPLY,
    });
    await h.run();
    expect(earcons(h.events)[0]).toBe('listening');
  });

  it('plays accepted then ready across a normal turn', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
    });
    await h.run();
    expect(earcons(h.events)).toEqual(['listening', 'accepted', 'ready']);
  });

  it('accepts the request before it is ready to speak', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
    });
    await h.run();

    const at = (sound: string) =>
      h.events.find((e) => e.event.type === 'earcon' && e.event.sound === sound)!.at;

    expect(at('accepted')).toBeLessThan(at('ready'));
    // And `ready` lands before the first audio it is announcing.
    expect(at('ready')).toBeLessThanOrEqual(audio(h.events)[0]!.at);
  });

  /**
   * Criterion 8's provider hiccup, heard rather than inferred: the brief asks for a
   * failed earcon rather than a hang, so the failure has to reach the user's ears.
   */
  it('plays the failure tone when a provider dies mid-reply', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
      failAfterTokens: 3,
      micMs: 8_000,
    });
    await h.run();

    expect(earcons(h.events)).toContain('failed');
    expect(h.llm.lastCall?.completed).toBe(false);
  });

  it('does not hang after a provider dies', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'what is the weather today', final: true }],
      reply: REPLY,
      failAfterTokens: 3,
      micMs: 8_000,
    });

    // The rig awaits the bridge to completion; a hang would time the suite out
    // rather than fail it, which is why finishing at all is the assertion.
    await h.run();
    expect(h.bridge.state).toBe('idle');
  });

  it('plays no failure tone on a healthy turn', async () => {
    const h = harness({
      script: [{ afterMs: 150, text: 'hello', final: true }],
      reply: REPLY,
    });
    await h.run();
    expect(earcons(h.events)).not.toContain('failed');
  });

  it('accepts each new request in a multi-turn conversation', async () => {
    const h = harness({
      script: [
        { afterMs: 150, text: 'first question', final: true },
        { afterMs: 4_000, text: 'second question', final: true },
      ],
      reply: REPLY,
      micMs: 14_000,
    });
    await h.run();

    expect(earcons(h.events).filter((e) => e === 'accepted')).toHaveLength(2);
    expect(earcons(h.events).filter((e) => e === 'listening')).toHaveLength(1);
  });
});
