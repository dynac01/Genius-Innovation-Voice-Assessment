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
import { createPipeline, describePipeline } from './pipeline.js';

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

  it('selects real providers from configuration alone', () => {
    const { pipeline } = createPipeline(clock, {
      ...KEYS,
      STT_PROVIDER: 'deepgram',
      LLM_PROVIDER: 'anthropic',
      TTS_PROVIDER: 'deepgram',
    });
    expect(pipeline.stt).toBeInstanceOf(DeepgramStt);
    expect(pipeline.llm).toBeInstanceOf(AnthropicLlm);
    expect(pipeline.tts).toBeInstanceOf(DeepgramTts);
  });

  /** The brief's own wording: "once with a real provider and once with the silent fake". */
  it('swaps only the TTS, leaving the rest of the pipeline alone', () => {
    const base = { ...KEYS, STT_PROVIDER: 'deepgram', LLM_PROVIDER: 'anthropic' };
    const real = createPipeline(clock, { ...base, TTS_PROVIDER: 'deepgram' }).pipeline;
    const fake = createPipeline(clock, { ...base, TTS_PROVIDER: 'fake-silent' }).pipeline;

    expect(real.tts).toBeInstanceOf(DeepgramTts);
    expect(fake.tts).toBeInstanceOf(SilentTts);
    expect(real.stt.constructor).toBe(fake.stt.constructor);
    expect(real.llm.constructor).toBe(fake.llm.constructor);
  });

  it('mixes real and fake stages independently', () => {
    const { pipeline } = createPipeline(clock, { ...KEYS, LLM_PROVIDER: 'anthropic' });
    expect(pipeline.llm).toBeInstanceOf(AnthropicLlm);
    expect(pipeline.stt).toBeInstanceOf(ScriptedStt);
  });

  /**
   * A missing key must fail at startup. Falling back to a fake would look like a
   * working demo that quietly ignores the provider you asked for.
   */
  it.each([
    ['STT_PROVIDER', 'deepgram', 'DEEPGRAM_API_KEY'],
    ['TTS_PROVIDER', 'deepgram', 'DEEPGRAM_API_KEY'],
    ['LLM_PROVIDER', 'anthropic', 'ANTHROPIC_API_KEY'],
  ])('fails loudly when %s=%s has no %s', (variable, value, key) => {
    expect(() => createPipeline(clock, { [variable]: value })).toThrow(key);
  });

  it('treats an empty key as missing', () => {
    expect(() => createPipeline(clock, { STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: '' })).toThrow(
      /required/,
    );
  });

  it('reports what is wired up', () => {
    expect(describePipeline({})).toEqual({ stt: 'fake', llm: 'fake', tts: 'fake' });
    expect(describePipeline({ STT_PROVIDER: 'deepgram' })).toMatchObject({ stt: 'deepgram' });
  });
});
