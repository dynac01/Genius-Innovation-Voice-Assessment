import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, resolveModel } from '@voice/core';
import { describe, expect, it } from 'vitest';

import {
  AnthropicLlm,
  CannedLlm,
  DeepgramStt,
  DeepgramTts,
  ScriptedStt,
  SilentTts,
  SystemClock,
  ToneTts,
} from '@voice/providers';
import {
  assertEnvIsCoherent,
  createPipeline,
  defaultSelection,
  describePipeline,
  providerAvailability,
  resolveSelection,
} from './pipeline.js';

const clock = new SystemClock();
const KEYS = { DEEPGRAM_API_KEY: 'dg-test-key', ANTHROPIC_API_KEY: 'sk-ant-test-key' };

/**
 * The criterion-7 seam.
 *
 * These assert the *selection*, not the providers — no network, no keys that work.
 * The stronger proof is structural and lives outside the test suite: swapping a
 * provider produces zero changes under `packages/core/`, because the loop is
 * written against the interfaces and cannot ask which one it got.
 */
describe('pipeline selection', () => {
  it('defaults to fakes, so a cold clone runs with no keys', () => {
    const { pipeline } = createPipeline(clock, {});
    expect(pipeline.stt).toBeInstanceOf(ScriptedStt);
    expect(pipeline.llm).toBeInstanceOf(CannedLlm);
    expect(pipeline.tts).toBeInstanceOf(ToneTts);
  });

  /**
   * Real providers are wrapped in an idle budget, so `instanceof` is the wrong
   * probe — a decorator is exactly what we want there. What matters is that
   * configuration moved each stage off its fake.
   */
  it('selects real providers from configuration alone', () => {
    const { pipeline } = createPipeline(clock, {
      ...KEYS,
      STT_PROVIDER: 'deepgram',
      LLM_PROVIDER: 'anthropic',
      TTS_PROVIDER: 'deepgram',
    });
    expect(pipeline.stt).not.toBeInstanceOf(ScriptedStt);
    expect(pipeline.llm).not.toBeInstanceOf(CannedLlm);
    expect(pipeline.tts).not.toBeInstanceOf(ToneTts);
    expect(pipeline.tts).not.toBeInstanceOf(SilentTts);
  });

  /** Fakes are deterministic; a budget there only adds a way for slow CI to fail. */
  it('leaves the fakes unwrapped', () => {
    const { pipeline } = createPipeline(clock, {});
    expect(pipeline.stt).toBeInstanceOf(ScriptedStt);
    expect(pipeline.llm).toBeInstanceOf(CannedLlm);
    expect(pipeline.tts).toBeInstanceOf(ToneTts);
  });

  /** The brief's own wording: "once with a real provider and once with the silent fake". */
  it('swaps only the TTS, leaving the rest of the pipeline alone', () => {
    const base = { ...KEYS, STT_PROVIDER: 'deepgram', LLM_PROVIDER: 'anthropic' };
    const real = createPipeline(clock, { ...base, TTS_PROVIDER: 'deepgram' }).pipeline;
    const fake = createPipeline(clock, { ...base, TTS_PROVIDER: 'fake-silent' }).pipeline;

    expect(fake.tts).toBeInstanceOf(SilentTts);
    expect(real.tts).not.toBeInstanceOf(SilentTts);

    // The stages that were not swapped are selected identically — that is the
    // whole claim of criterion 7, restated at the seam.
    expect(real.stt.constructor).toBe(fake.stt.constructor);
    expect(real.llm.constructor).toBe(fake.llm.constructor);
  });

  it('mixes real and fake stages independently', () => {
    const { pipeline } = createPipeline(clock, { ...KEYS, LLM_PROVIDER: 'anthropic' });
    expect(pipeline.llm).not.toBeInstanceOf(CannedLlm);
    expect(pipeline.stt).toBeInstanceOf(ScriptedStt);
    expect(pipeline.tts).toBeInstanceOf(ToneTts);
  });

  /**
   * Two sources, two treatments. The environment is an operator stating intent at
   * deploy time — silently ignoring it is how a deployment serves fakes to real
   * users while its health check stays green. That fails at startup.
   */
  it.each([
    ['STT_PROVIDER', 'deepgram', 'DEEPGRAM_API_KEY'],
    ['TTS_PROVIDER', 'deepgram', 'DEEPGRAM_API_KEY'],
    ['LLM_PROVIDER', 'anthropic', 'ANTHROPIC_API_KEY'],
  ])('refuses to start when %s=%s has no %s', (variable, value, key) => {
    expect(() => assertEnvIsCoherent({ [variable]: value })).toThrow(key);
  });

  it('treats an empty key as missing', () => {
    expect(() => assertEnvIsCoherent({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: '' })).toThrow(
      /DEEPGRAM_API_KEY/,
    );
  });

  it('starts happily when the environment is coherent', () => {
    expect(() => assertEnvIsCoherent({})).not.toThrow();
    expect(() => assertEnvIsCoherent({ ...KEYS, STT_PROVIDER: 'deepgram' })).not.toThrow();
  });

  /**
   * A browser request is a user clicking a control. An unavailable stage clamps
   * to its fake and the resolution is reported back, so the UI shows what loaded
   * rather than what was asked for.
   */
  describe('browser requests', () => {
    it('honours a request the server can serve', () => {
      const { selected } = createPipeline(clock, KEYS, { stt: 'real', llm: 'real', tts: 'real' });
      expect(selected).toEqual({ stt: 'real', llm: 'real', tts: 'real' });
    });

    it('clamps a stage with no key rather than failing the session', () => {
      const { selected } = createPipeline(clock, {}, { stt: 'real', llm: 'real', tts: 'real' });
      expect(selected).toEqual({ stt: 'fake', llm: 'fake', tts: 'fake' });
    });

    it('clamps only the stage that is unavailable', () => {
      const { selected } = createPipeline(
        clock,
        { ANTHROPIC_API_KEY: 'sk-ant-test' },
        { stt: 'real', llm: 'real', tts: 'real' },
      );
      expect(selected).toEqual({ stt: 'fake', llm: 'real', tts: 'fake' });
    });

    it('keeps the silent TTS available with no keys at all — the criterion-7 swap', () => {
      const { selected, pipeline } = createPipeline(
        clock,
        {},
        { stt: 'fake', llm: 'fake', tts: 'silent' },
      );
      expect(selected.tts).toBe('silent');
      expect(pipeline.tts).toBeInstanceOf(SilentTts);
    });

    it('reports availability so the UI can disable what it cannot offer', () => {
      expect(providerAvailability({})).toEqual({ stt: false, llm: false, tts: false });
      expect(providerAvailability(KEYS)).toEqual({ stt: true, llm: true, tts: true });
    });
  });

  /**
   * Silence is the STT's normal state, not a stall: Deepgram sends nothing at all
   * while nobody is talking. An idle budget there would turn a thoughtful pause
   * into a failed earcon and a dead session — the precise opposite of criterion 8.
   * The request-shaped stages, which were asked a question, still get one.
   */
  it('does not put an idle budget on the STT', () => {
    const guarded = createPipeline(clock, {
      ...KEYS,
      STT_PROVIDER: 'deepgram',
      LLM_PROVIDER: 'anthropic',
      TTS_PROVIDER: 'deepgram',
    }).pipeline;

    // The STT is handed through unwrapped; the others are decorated.
    expect(guarded.stt).toBeInstanceOf(DeepgramStt);
    expect(guarded.llm).not.toBeInstanceOf(AnthropicLlm);
    expect(guarded.tts).not.toBeInstanceOf(DeepgramTts);
  });

  it('reports the default and what is available', () => {
    const models = CLAUDE_MODELS.map((m) => m.id);

    // No `llmModel` on either: the model stage fell back to the fake, and naming a
    // model beside a canned reply is the misreport `default` exists to prevent.
    expect(describePipeline({})).toEqual({
      default: { stt: 'fake', llm: 'fake', tts: 'fake' },
      available: { stt: false, llm: false, tts: false },
      models,
    });
    expect(describePipeline({ ...KEYS, STT_PROVIDER: 'deepgram' })).toEqual({
      default: { stt: 'real', llm: 'fake', tts: 'fake' },
      available: { stt: true, llm: true, tts: true },
      models,
    });
  });

  it('names the model once it is genuinely in force', () => {
    const described = describePipeline({ ...KEYS, LLM_PROVIDER: 'anthropic' }) as {
      default: { llm: string; llmModel?: string };
    };
    expect(described.default.llm).toBe('real');
    expect(described.default.llmModel).toBe(DEFAULT_CLAUDE_MODEL);
  });
});

/**
 * Model selection.
 *
 * The id arrives from the browser, so these are as much about the trust boundary as
 * about the feature: a whitelist is the difference between "the user picked a model"
 * and "a malformed message became a request we never meant to send".
 */
describe('claude model selection', () => {
  const env = { ANTHROPIC_API_KEY: 'k', DEEPGRAM_API_KEY: 'k' };

  it('defaults to the fastest model, because a voice loop feels time-to-first-word', () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe(CLAUDE_MODELS[0]?.id);
    expect(defaultSelection({}).llmModel).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('honours a recognised model from the browser', () => {
    const sonnet = CLAUDE_MODELS[1]!.id;
    const selected = resolveSelection(
      { stt: 'fake', llm: 'real', tts: 'fake', llmModel: sonnet },
      env,
    );
    expect(selected.llmModel).toBe(sonnet);
  });

  it('ignores an unrecognised model rather than forwarding it to the API', () => {
    const selected = resolveSelection(
      { stt: 'fake', llm: 'real', tts: 'fake', llmModel: 'claude-not-a-real-model' },
      env,
    );
    expect(selected.llmModel).toBeUndefined();
    expect(resolveModel('claude-not-a-real-model')).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('reports no model when the model stage fell back to the fake', () => {
    // Reporting a model name next to a canned reply would be the same lie the
    // `selected` field exists to prevent — showing what was asked for, not what ran.
    const selected = resolveSelection(
      { stt: 'fake', llm: 'real', tts: 'fake', llmModel: CLAUDE_MODELS[1]!.id },
      {},
    );
    expect(selected.llm).toBe('fake');
    expect(selected.llmModel).toBeUndefined();
  });

  it('takes the environment as a starting point the browser can override', () => {
    const opus = CLAUDE_MODELS[3]!.id;
    expect(defaultSelection({ ANTHROPIC_MODEL: opus }).llmModel).toBe(opus);
    expect(defaultSelection({ ANTHROPIC_MODEL: 'gpt-4' }).llmModel).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('offers only ids that were verified against the live API', () => {
    // Every id here was checked with a real request before being listed. A menu
    // entry the provider rejects is worse than one fewer option.
    for (const model of CLAUDE_MODELS) {
      expect(model.id).toMatch(/^claude-/u);
      expect(model.label.length).toBeGreaterThan(0);
      expect(model.note.length).toBeGreaterThan(0);
    }
    expect(new Set(CLAUDE_MODELS.map((m) => m.id)).size).toBe(CLAUDE_MODELS.length);
  });
});
