/**
 * The fakes.
 *
 * Not test doubles bolted on at the end — these are the harness for every
 * control-flow test and the standing proof that the pluggable boundary is real.
 * They are also the zero-key default, so the app runs end to end from a cold clone
 * with no accounts and no spend.
 *
 * All three model *timing*, not just shape. See docs/TESTING.md §3.
 */

export type { FakeMicrophoneOptions } from './audio-source.js';
export { fakeMicrophone } from './audio-source.js';

export type { ScriptedSttOptions, SttScriptStep } from './scripted-stt.js';
export { ScriptedStt } from './scripted-stt.js';

export type { CannedLlmOptions, LlmCall } from './canned-llm.js';
export { CannedLlm } from './canned-llm.js';

export type { SilentTtsOptions, TtsRequest } from './silent-tts.js';
export { SilentTts } from './silent-tts.js';
