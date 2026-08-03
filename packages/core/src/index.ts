/**
 * @voice/core — the reusable voice loop.
 *
 * This package holds the loop, the pluggable pipeline interfaces, the bridge/dialog
 * protocol, and the turn + barge-in state machines. It performs no I/O: no network,
 * no filesystem, no audio devices, no timers it does not own. Everything that talks
 * to the outside world lives in @voice/providers or the apps.
 *
 * That constraint is enforced three ways:
 *   - `"types": []` in tsconfig.json, so platform globals are not even in scope
 *   - a `no-restricted-imports` ESLint rule banning `node:*` and provider SDKs
 *   - this package declaring zero runtime dependencies
 */

export const CORE_PACKAGE = '@voice/core' as const;

export type { AudioChunk, AudioStream, TextSpan } from './audio.js';
export { chunkDurationMs, samplesForMs, silentFrame, totalDurationMs } from './audio.js';

export type { Message, Role } from './messages.js';

export type { LLM, Pipeline, ReplyDelta, STT, Transcript, TTS } from './pipeline.js';

export type { BargeInBehavior, Dialog, EarconSound, FromBridge, ToBridge } from './protocol.js';

export type { Clock } from './clock.js';
export { VirtualClock } from './clock.js';

export { AsyncQueue } from './async-queue.js';

export type { TurnEvent, TurnState } from './turn.js';
export { TurnMachine, accepts, transition } from './turn.js';

export type { EndpointerConfig, EndpointerInput, EndpointerOutcome } from './endpointer.js';
export { DEFAULT_ENDPOINTER, Endpointer } from './endpointer.js';

export type { ChunkerConfig } from './chunker.js';
export { ClauseChunker, DEFAULT_CHUNKER } from './chunker.js';

export type { StartRaceOutcome } from './start-race.js';
export { StartRace } from './start-race.js';

export type { IdleTimeoutOptions } from './timeout.js';
export { ProviderStallError, withIdleTimeout } from './timeout.js';

export type { VadConfig, VadEvent } from './vad.js';
export { DEFAULT_VAD, Vad, frameLevelDb } from './vad.js';

export type { EarconSpec, EarconTone } from './earcons.js';
export { EARCONS, EARCON_MAX_MS, EARCON_SOUNDS, earconDurationMs, earconPeak } from './earcons.js';

export type { UtteranceIntent } from './intent.js';
export { bargeInFor, classifyUtterance, normalizeUtterance } from './intent.js';

export type { AudioBridgeOptions, BridgeEvent, InterruptedReply } from './bridge.js';
export { AudioBridge } from './bridge.js';

export type { StubDialogOptions } from './stub-dialog.js';
export { StubDialog } from './stub-dialog.js';

export type {
  AudioFrame,
  ClientEvent,
  PipelineAvailability,
  PipelineSelection,
  ServerEvent,
} from './wire.js';
export {
  AUDIO_HEADER_BYTES,
  decodeAudioFrame,
  encodeAudioFrame,
  isClientEvent,
  isServerEvent,
} from './wire.js';
