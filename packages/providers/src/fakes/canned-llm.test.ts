import { VirtualClock } from '@voice/core';
import type { Message } from '@voice/core';
import { describe, expect, it } from 'vitest';

import { CannedLlm } from './canned-llm.js';

const HISTORY: Message[] = [{ role: 'user', content: 'what is the weather today' }];

describe('CannedLlm', () => {
  it('streams the reply in pieces rather than all at once', async () => {
    const clock = new VirtualClock();
    const llm = new CannedLlm({ clock, reply: 'It is sunny and mild.' });

    const deltas: string[] = [];
    const consuming = (async () => {
      for await (const delta of llm.respond(HISTORY)) deltas.push(delta.text);
    })();
    await clock.runUntilIdle();
    await consuming;

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('It is sunny and mild.');
  });

  it('honours time-to-first-token and inter-token pacing', async () => {
    const clock = new VirtualClock();
    const llm = new CannedLlm({ clock, reply: 'one two three', ttftMs: 200, interTokenMs: 50 });

    const at: number[] = [];
    const consuming = (async () => {
      for await (const _ of llm.respond(HISTORY)) at.push(clock.now());
    })();
    await clock.runUntilIdle();
    await consuming;

    expect(at).toEqual([200, 250, 300]);
  });

  it('records the conversation it was handed', async () => {
    const clock = new VirtualClock();
    const llm = new CannedLlm({ clock, reply: 'ok' });

    const consuming = (async () => {
      for await (const _ of llm.respond(HISTORY)) {
        /* drain */
      }
    })();
    await clock.runUntilIdle();
    await consuming;

    expect(llm.calls).toHaveLength(1);
    expect(llm.lastCall?.messages).toEqual(HISTORY);
    expect(llm.lastCall?.completed).toBe(true);
  });

  /**
   * An abandoned reply — criterion 3. The distinction between "finished" and
   * "walked away from" has to be observable, or a test cannot tell a completed turn
   * from an interrupted one.
   */
  it('reports a reply the consumer walked away from as incomplete', async () => {
    const clock = new VirtualClock();
    const llm = new CannedLlm({ clock, reply: 'one two three four five six' });

    const consuming = (async () => {
      let seen = 0;
      for await (const _ of llm.respond(HISTORY)) {
        seen += 1;
        if (seen === 2) break;
      }
    })();
    await clock.runUntilIdle();
    await consuming;

    expect(llm.lastCall?.completed).toBe(false);
    expect(llm.lastCall?.tokensEmitted).toBe(2);
    expect(llm.lastCall?.textEmitted).toBe('one two ');
  });

  it('handles an empty reply', async () => {
    const clock = new VirtualClock();
    const llm = new CannedLlm({ clock, reply: '' });

    const deltas: string[] = [];
    const consuming = (async () => {
      for await (const delta of llm.respond(HISTORY)) deltas.push(delta.text);
    })();
    await clock.runUntilIdle();
    await consuming;

    expect(deltas).toEqual([]);
    expect(llm.lastCall?.completed).toBe(true);
  });
});
