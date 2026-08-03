import { VirtualClock } from '@voice/core';
import type { AudioChunk, Message } from '@voice/core';
import { CannedLlm, ScriptedStt, SilentTts, fakeMicrophone } from '@voice/providers';
import { describe, expect, it } from 'vitest';

/**
 * Phase 1's definition of done: a scripted conversation runs end to end through the
 * three fakes, on virtual time, with no audio device and no API key.
 *
 * The driver below is deliberately naive — it waits for the whole reply before
 * synthesising. The real loop streams the LLM into TTS incrementally so speech
 * starts before the reply is complete; that is criterion 5 and lands in Phase 3.
 * What this proves is narrower and worth proving first: the three interfaces
 * compose, the recordings line up, and the result is deterministic.
 */

const SPOKEN = 'what is the weather today';
const REPLY = 'It is sunny and mild in Lisbon, around twenty two degrees.';

interface Turn {
  readonly partials: string[];
  readonly finalText: string;
  readonly reply: string;
  readonly audio: AudioChunk[];
  readonly firstAudioAt: number;
  readonly finalTranscriptAt: number;
  readonly elapsedMs: number;
}

/** Stops consuming assistant audio after N frames, standing in for a barge-in. */
async function runTurn(stopAudioAfter?: number): Promise<{
  turn: Turn;
  llm: CannedLlm;
  tts: SilentTts;
}> {
  const clock = new VirtualClock();

  const stt = new ScriptedStt({
    clock,
    script: [
      { afterMs: 120, text: 'what is', final: false },
      { afterMs: 180, text: 'what is the weather', final: false },
      { afterMs: 200, text: SPOKEN, final: true },
    ],
  });
  const llm = new CannedLlm({ clock, reply: REPLY, ttftMs: 150, interTokenMs: 25 });
  const tts = new SilentTts({ clock, ttfbMs: 60, frameMs: 20, charsPerSecond: 15 });

  const partials: string[] = [];
  let finalText = '';
  let finalTranscriptAt = 0;
  let reply = '';
  const audio: AudioChunk[] = [];
  let firstAudioAt = 0;

  const conversation = (async () => {
    const mic = fakeMicrophone({ clock, durationMs: 3_000 });

    for await (const result of stt.transcribeStream(mic)) {
      if (!result.final) {
        partials.push(result.text);
        continue;
      }
      finalText = result.text;
      finalTranscriptAt = clock.now();
      break;
    }

    const history: Message[] = [{ role: 'user', content: finalText }];
    for await (const delta of llm.respond(history)) reply += delta.text;

    for await (const chunk of tts.synthesizeStream(reply)) {
      if (audio.length === 0) firstAudioAt = clock.now();
      audio.push(chunk);
      if (stopAudioAfter !== undefined && audio.length >= stopAudioAfter) break;
    }
  })();

  await clock.runUntilIdle();
  await conversation;

  return {
    turn: {
      partials,
      finalText,
      reply,
      audio,
      firstAudioAt,
      finalTranscriptAt,
      elapsedMs: clock.now(),
    },
    llm,
    tts,
  };
}

describe('scripted conversation through the fakes', () => {
  it('runs a full turn with no audio device and no API key', async () => {
    const { turn, llm, tts } = await runTurn();

    expect(turn.partials).toEqual(['what is', 'what is the weather']);
    expect(turn.finalText).toBe(SPOKEN);

    // The model saw what was actually said, not a partial.
    expect(llm.lastCall?.messages).toEqual([{ role: 'user', content: SPOKEN }]);
    expect(llm.lastCall?.completed).toBe(true);

    // Speech synthesis received the model's reply verbatim.
    expect(turn.reply).toBe(REPLY);
    expect(tts.lastRequest).toMatchObject({ text: REPLY, completed: true });

    expect(turn.audio.length).toBeGreaterThan(0);
    expect(turn.audio.at(-1)?.span?.end).toBe(REPLY.length);
  });

  it('orders the stages: transcript, then reply, then audio', async () => {
    const { turn } = await runTurn();

    expect(turn.finalTranscriptAt).toBe(500);
    expect(turn.firstAudioAt).toBeGreaterThan(turn.finalTranscriptAt);
  });

  /**
   * Determinism is the property the whole control-flow suite rests on. Two runs of
   * the same script must produce identical timings — if virtual time leaked into
   * wall time anywhere, this is where it would show up as flake.
   */
  it('is deterministic across runs', async () => {
    const a = await runTurn();
    const b = await runTurn();

    expect(a.turn.elapsedMs).toBe(b.turn.elapsedMs);
    expect(a.turn.firstAudioAt).toBe(b.turn.firstAudioAt);
    expect(a.turn.audio.length).toBe(b.turn.audio.length);
  });

  /**
   * A preview of the mechanics criteria 1 and 2 will need: when audio consumption
   * stops mid-reply, what the user heard is recoverable — and it is a prefix of the
   * reply, not the whole thing. The loop that acts on this arrives in Phase 4/5.
   */
  it('leaves a recoverable resume point when audio stops mid-reply', async () => {
    const { turn, tts } = await runTurn(6);
    const request = tts.lastRequest!;

    expect(request.completed).toBe(false);
    expect(request.framesEmitted).toBe(6);

    const heard = REPLY.slice(0, request.charsEmitted);
    const remaining = REPLY.slice(request.charsEmitted);

    expect(heard.length).toBeGreaterThan(0);
    expect(remaining.length).toBeGreaterThan(0);
    expect(heard + remaining).toBe(REPLY);
    expect(request.charsEmitted).toBe(turn.audio.at(-1)?.span?.end);
  });
});
