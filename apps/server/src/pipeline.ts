import type {
  AudioChunk,
  AudioStream,
  Clock,
  Dialog,
  LLM,
  Message,
  Pipeline,
  STT,
  TTS,
} from '@voice/core';
import { StubDialog, withIdleTimeout } from '@voice/core';
import {
  AnthropicLlm,
  CannedLlm,
  DeepgramStt,
  DeepgramTts,
  ScriptedStt,
  SilentTts,
  ToneTts,
} from '@voice/providers';

/**
 * Which implementations the loop is handed.
 *
 * This file is the whole of criterion 7. Swapping a provider is an env var here;
 * nothing under `packages/core` knows which branch was taken, because the loop is
 * written against `STT`, `LLM`, and `TTS` and has no way to ask. The check is a
 * `git diff` across the swap showing zero changes in core — see docs/TESTING.md §5.
 *
 * Fakes are the default so the app runs end to end from a cold clone with no keys
 * and no spend. Real providers are opt-in, and a missing key fails loudly at
 * startup rather than as a puzzling silence on the first turn.
 */

export type Env = Record<string, string | undefined>;

/**
 * How long a real provider may send nothing before it is declared stalled.
 *
 * Generous, because these are idle budgets rather than total ones — a long reply
 * is not a stall. They exist for the failure with no error attached: a socket that
 * stays open while the provider quietly stops sending. Without them the loop waits
 * forever and the user just sees an assistant with nothing to say.
 *
 * Not applied to the fakes: they are deterministic, and a budget there would only
 * add a way for a slow CI machine to fail a test.
 */
const IDLE_BUDGET_MS = { stt: 15_000, llm: 8_000, tts: 8_000 } as const;

function guardStt(stt: STT, clock: Clock, label: string): STT {
  return {
    transcribeStream: (audio: AudioStream) =>
      withIdleTimeout(stt.transcribeStream(audio), {
        clock,
        idleMs: IDLE_BUDGET_MS.stt,
        label,
      }),
  };
}

function guardLlm(llm: LLM, clock: Clock, label: string): LLM {
  return {
    respond: (messages: Message[]) =>
      withIdleTimeout(llm.respond(messages), { clock, idleMs: IDLE_BUDGET_MS.llm, label }),
  };
}

function guardTts(tts: TTS, clock: Clock, label: string): TTS {
  return {
    synthesizeStream: (text: string): AsyncIterable<AudioChunk> =>
      withIdleTimeout(tts.synthesizeStream(text), {
        clock,
        idleMs: IDLE_BUDGET_MS.tts,
        label,
      }),
  };
}

const DEMO_SCRIPT = [
  { afterMs: 900, text: 'what is', final: false },
  { afterMs: 500, text: 'what is the weather', final: false },
  { afterMs: 600, text: 'what is the weather today', final: true },
];

const DEMO_REPLY = 'It is sunny and mild in Lisbon today, around twenty two degrees.';

function required(env: Env, name: string, provider: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required for ${provider}. Set it in .env, or unset the provider to use the fake.`,
    );
  }
  return value;
}

function createStt(clock: Clock, env: Env): STT {
  switch (env['STT_PROVIDER'] ?? 'fake') {
    case 'deepgram':
      return guardStt(
        new DeepgramStt({ apiKey: required(env, 'DEEPGRAM_API_KEY', 'STT_PROVIDER=deepgram') }),
        clock,
        'deepgram-stt',
      );
    default:
      return new ScriptedStt({ clock, script: DEMO_SCRIPT });
  }
}

function createLlm(clock: Clock, env: Env): LLM {
  switch (env['LLM_PROVIDER'] ?? 'fake') {
    case 'anthropic': {
      const model = env['ANTHROPIC_MODEL'];
      return guardLlm(
        new AnthropicLlm({
          apiKey: required(env, 'ANTHROPIC_API_KEY', 'LLM_PROVIDER=anthropic'),
          ...(model === undefined || model === '' ? {} : { model }),
        }),
        clock,
        'anthropic-llm',
      );
    }
    default:
      return new CannedLlm({ clock, reply: DEMO_REPLY, ttftMs: 200, interTokenMs: 40 });
  }
}

function createTts(clock: Clock, env: Env): TTS {
  switch (env['TTS_PROVIDER'] ?? 'fake') {
    case 'deepgram':
      return guardTts(
        new DeepgramTts({ apiKey: required(env, 'DEEPGRAM_API_KEY', 'TTS_PROVIDER=deepgram') }),
        clock,
        'deepgram-tts',
      );
    // The silent fake is the other half of the criterion-7 demonstration: the same
    // loop run once against a real provider and once against a fake that emits
    // nothing but correctly-shaped silence.
    case 'fake-silent':
      return new SilentTts({ clock, sampleRate: 24_000 });
    default:
      // Audible by default, so the demo can be checked by ear with no keys.
      return new ToneTts({ clock, sampleRate: 24_000 });
  }
}

export function createPipeline(
  clock: Clock,
  env: Env = {},
): { pipeline: Pipeline; dialog: Dialog } {
  const llm = createLlm(clock, env);
  const pipeline: Pipeline = { stt: createStt(clock, env), llm, tts: createTts(clock, env) };

  // The model sits behind the dialog, not inside the bridge. A more capable
  // decision engine replaces this line and nothing else.
  return { pipeline, dialog: new StubDialog({ llm }) };
}

/** What is actually wired up — for the startup banner and `/health`. */
export function describePipeline(env: Env = {}): Record<string, string> {
  return {
    stt: env['STT_PROVIDER'] ?? 'fake',
    llm: env['LLM_PROVIDER'] ?? 'fake',
    tts: env['TTS_PROVIDER'] ?? 'fake',
  };
}
