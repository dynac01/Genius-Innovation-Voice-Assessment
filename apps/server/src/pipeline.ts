import type { Clock, Dialog, Pipeline } from '@voice/core';
import { StubDialog } from '@voice/core';
import { CannedLlm, ScriptedStt, SilentTts, ToneTts } from '@voice/providers';

/**
 * Which implementations the loop is handed.
 *
 * Phase 7 branches on `STT_PROVIDER` / `LLM_PROVIDER` / `TTS_PROVIDER` to reach the
 * real services. Until then everything resolves to a fake, which is why the app
 * runs end to end from a cold clone with no keys and no spend.
 *
 * The audible tone is the default for the *demo*, not for tests: Phase 2 has to be
 * verifiable by ear on a real phone. `TTS_PROVIDER=fake-silent` selects the silent
 * one when that is what you want.
 */
export function createPipeline(
  clock: Clock,
  env: Record<string, string | undefined> = {},
): { pipeline: Pipeline; dialog: Dialog } {
  const ttsKind = env['TTS_PROVIDER'] ?? 'fake-tone';

  const llm = new CannedLlm({
    clock,
    reply: 'It is sunny and mild in Lisbon today, around twenty two degrees.',
    ttftMs: 200,
    interTokenMs: 40,
  });

  const pipeline: Pipeline = {
    stt: new ScriptedStt({
      clock,
      script: [
        { afterMs: 900, text: 'what is', final: false },
        { afterMs: 500, text: 'what is the weather', final: false },
        { afterMs: 600, text: 'what is the weather today', final: true },
      ],
    }),
    llm,
    tts:
      ttsKind === 'fake-silent'
        ? new SilentTts({ clock, sampleRate: 24_000 })
        : new ToneTts({ clock, sampleRate: 24_000 }),
  };

  // The model sits behind the dialog, not inside the bridge. A more capable decision
  // engine replaces this line and nothing else.
  return { pipeline, dialog: new StubDialog({ llm }) };
}
