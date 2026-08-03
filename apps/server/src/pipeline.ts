import type {
  AudioChunk,
  Clock,
  Dialog,
  EndpointerConfig,
  LLM,
  Message,
  Pipeline,
  PipelineAvailability,
  PipelineSelection,
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
 * **Only the request-shaped stages get one.** The LLM and TTS are called per
 * reply: silence from either means something is wrong, because they were asked a
 * question. The STT is a session-long stream where silence is the *normal* state —
 * it means nobody is talking. Deepgram sends literally nothing during silence, so
 * an STT budget turns "the user paused to think" into a failed earcon and a dead
 * session, which is the precise opposite of criterion 8's requirement that
 * sustained silence produce no spurious response.
 *
 * Not applied to the fakes either: they are deterministic, and a budget there
 * would only add a way for a slow CI machine to fail a test.
 */
const IDLE_BUDGET_MS = { llm: 8_000, tts: 8_000 } as const;

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

const has = (env: Env, name: string): boolean => {
  const value = env[name];
  return value !== undefined && value !== '';
};

/** Which stages can be real, i.e. have a key configured. */
export function providerAvailability(env: Env): PipelineAvailability {
  return {
    stt: has(env, 'DEEPGRAM_API_KEY'),
    llm: has(env, 'ANTHROPIC_API_KEY'),
    tts: has(env, 'DEEPGRAM_API_KEY'),
  };
}

/**
 * The default selection, from the environment.
 *
 * `.env` still sets what a session *starts* as — useful for a deployment that
 * should be real out of the box — but the browser can change it per session. The
 * environment is the default, not the authority.
 */
export function defaultSelection(env: Env): PipelineSelection {
  const real = (name: string, want: string) => (env[name] ?? 'fake') === want;
  return {
    stt: real('STT_PROVIDER', 'deepgram') ? 'real' : 'fake',
    llm: real('LLM_PROVIDER', 'anthropic') ? 'real' : 'fake',
    tts: real('TTS_PROVIDER', 'deepgram')
      ? 'real'
      : (env['TTS_PROVIDER'] ?? 'fake') === 'fake-silent'
        ? 'silent'
        : 'fake',
  };
}

/**
 * Validate the environment's own defaults, loudly.
 *
 * Two sources ask for providers and they deserve different treatment. A *browser*
 * request is a user clicking a control, so an unavailable stage clamps to its fake
 * and the resolution is reported back. The *environment* is an operator stating
 * intent at deploy time, and silently ignoring that is how a deployment ends up
 * serving fakes to real users while looking healthy. That one throws.
 */
export function assertEnvIsCoherent(env: Env): void {
  const can = providerAvailability(env);
  const want = defaultSelection(env);
  const missing: string[] = [];
  if (want.stt === 'real' && !can.stt) missing.push('STT_PROVIDER=deepgram needs DEEPGRAM_API_KEY');
  if (want.llm === 'real' && !can.llm)
    missing.push('LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
  if (want.tts === 'real' && !can.tts) missing.push('TTS_PROVIDER=deepgram needs DEEPGRAM_API_KEY');
  if (missing.length > 0) {
    throw new Error(
      `Incoherent provider configuration:\n  ${missing.join('\n  ')}\n` +
        'Set the key, or select the fake. Falling back silently would serve fakes while looking healthy.',
    );
  }
}

/**
 * Clamp a request to what the server can actually honour.
 *
 * A stage asked to be real without a key falls back to its fake rather than
 * failing the session — and the resolution is reported back, so the UI shows what
 * loaded rather than what was requested. Silently claiming a provider that never
 * loaded is the failure worth avoiding here.
 */
export function resolveSelection(want: PipelineSelection, env: Env): PipelineSelection {
  const can = providerAvailability(env);
  return {
    stt: want.stt === 'real' && can.stt ? 'real' : 'fake',
    llm: want.llm === 'real' && can.llm ? 'real' : 'fake',
    tts: want.tts === 'real' && can.tts ? 'real' : want.tts === 'silent' ? 'silent' : 'fake',
  };
}

function createStt(clock: Clock, env: Env, choice: PipelineSelection['stt']): STT {
  // Deliberately unguarded — see IDLE_BUDGET_MS. A dead STT socket surfaces as a
  // close or an error, both of which already propagate.
  return choice === 'real'
    ? new DeepgramStt({ apiKey: env['DEEPGRAM_API_KEY'] ?? '' })
    : new ScriptedStt({ clock, script: DEMO_SCRIPT });
}

function createLlm(clock: Clock, env: Env, choice: PipelineSelection['llm']): LLM {
  if (choice !== 'real') {
    return new CannedLlm({ clock, reply: DEMO_REPLY, ttftMs: 200, interTokenMs: 40 });
  }
  const model = env['ANTHROPIC_MODEL'];
  return guardLlm(
    new AnthropicLlm({
      apiKey: env['ANTHROPIC_API_KEY'] ?? '',
      ...(model === undefined || model === '' ? {} : { model }),
    }),
    clock,
    'anthropic-llm',
  );
}

function createTts(clock: Clock, env: Env, choice: PipelineSelection['tts']): TTS {
  if (choice === 'real') {
    return guardTts(
      new DeepgramTts({ apiKey: env['DEEPGRAM_API_KEY'] ?? '' }),
      clock,
      'deepgram-tts',
    );
  }
  // The silent fake is the other half of the criterion-7 demonstration: the same
  // loop run once against a real provider and once against one that emits nothing
  // but correctly-shaped silence.
  if (choice === 'silent') return new SilentTts({ clock, sampleRate: 24_000 });
  // Audible otherwise, so the demo can be checked by ear with no keys.
  return new ToneTts({ clock, sampleRate: 24_000 });
}

/**
 * End-of-turn tuning, which depends on what the STT means by "final".
 *
 * The fakes emit `final` only where a script deliberately says so, which is a
 * statement that the speaker stopped — so it can be trusted. Deepgram emits
 * `speech_final` on its own short silence timer, ~200ms, which is well inside an
 * ordinary mid-sentence pause. Trusting *that* hands the end-of-turn decision to
 * the provider and bypasses this endpointer entirely: the assistant starts
 * answering while you are still mid-thought.
 *
 * So with a real provider the finals are treated as speech activity rather than a
 * verdict, and the silence window here owns the decision. Deepgram's own ~200ms
 * absorbs part of the wait, which is why the window is shorter than the 700ms
 * default rather than stacked on top of it.
 */
function endpointerFor(choice: PipelineSelection['stt']): Partial<EndpointerConfig> {
  return choice === 'real'
    ? { trustSttFinal: false, endOfTurnMs: 550, pauseMs: 300 }
    : { trustSttFinal: true };
}

export interface PipelineSetup {
  readonly pipeline: Pipeline;
  readonly dialog: Dialog;
  readonly endpointer: Partial<EndpointerConfig>;
  /** What was actually resolved, which may differ from what was requested. */
  readonly selected: PipelineSelection;
}

export function createPipeline(
  clock: Clock,
  env: Env = {},
  want?: PipelineSelection,
): PipelineSetup {
  const selected = resolveSelection(want ?? defaultSelection(env), env);
  const llm = createLlm(clock, env, selected.llm);
  const pipeline: Pipeline = {
    stt: createStt(clock, env, selected.stt),
    llm,
    tts: createTts(clock, env, selected.tts),
  };

  // The model sits behind the dialog, not inside the bridge. A more capable
  // decision engine replaces this line and nothing else.
  return {
    pipeline,
    dialog: new StubDialog({ llm }),
    endpointer: endpointerFor(selected.stt),
    selected,
  };
}

/** What the server would start with — for the banner and `/health`. */
export function describePipeline(env: Env = {}): Record<string, unknown> {
  return {
    default: resolveSelection(defaultSelection(env), env),
    available: providerAvailability(env),
  };
}
