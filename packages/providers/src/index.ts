/**
 * @voice/providers — implementations of the @voice/core pipeline interfaces.
 *
 * Two families live here and they are peers, not test doubles and production code:
 *
 *   - Fakes: scripted STT, canned LLM, silent TTS. The harness for every
 *     control-flow test, the proof that the pluggable boundary is real, and the
 *     zero-key default so the app runs from a cold clone.
 *
 *   - Real: Deepgram Nova-3 (STT), Deepgram Aura-2 (TTS), Claude Haiku 4.5 (LLM).
 *     Land in Phase 7; see docs/WORKPLAN.md.
 *
 * Selection is by configuration. Swapping one must require no change to the loop.
 */

export const PROVIDERS_PACKAGE = '@voice/providers' as const;

export * from './fakes/index.js';
export { SystemClock } from './clock.js';

export type { AnthropicLlmOptions } from './anthropic/llm.js';
export { AnthropicLlm } from './anthropic/llm.js';

export type { DeepgramSttOptions } from './deepgram/stt.js';
export { DeepgramStt } from './deepgram/stt.js';

export type { DeepgramTtsOptions } from './deepgram/tts.js';
export { DeepgramTts } from './deepgram/tts.js';
