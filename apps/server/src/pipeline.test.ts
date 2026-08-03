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
  describePipeline,
  providerAvailability,
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
    expect(describePipeline({})).toEqual({
      default: { stt: 'fake', llm: 'fake', tts: 'fake' },
      available: { stt: false, llm: false, tts: false },
    });
    expect(describePipeline({ ...KEYS, STT_PROVIDER: 'deepgram' })).toEqual({
      default: { stt: 'real', llm: 'fake', tts: 'fake' },
      available: { stt: true, llm: true, tts: true },
    });
  });
});
