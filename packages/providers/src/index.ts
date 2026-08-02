/**
 * @voice/providers — implementations of the @voice/core pipeline interfaces.
 *
 * Two families live here and they are peers, not test doubles and production code:
 *
 *   - Fakes: scripted STT, canned LLM, silent TTS. These are the harness for every
 *     control-flow test and the proof that the pluggable boundary is real. They model
 *     *timing*, not just shape — a TTS that returned instantly would make barge-in
 *     tests pass trivially, because there would be no window in which to interrupt.
 *
 *   - Real: Deepgram Nova-3 (STT), Deepgram Aura-2 (TTS), Claude Haiku 4.5 (LLM).
 *
 * Selection is by configuration. Fakes are the zero-key default so the app runs
 * end to end from a cold clone.
 *
 * Implementations land in Phase 1 (fakes) and Phase 7 (real); see docs/WORKPLAN.md.
 */

import { CORE_PACKAGE } from '@voice/core';

/** Identifies this package across the workspace. */
export const PROVIDERS_PACKAGE = '@voice/providers' as const;

/**
 * The core package this build is wired against. Exists so the scaffold can prove
 * cross-package resolution works before any real code depends on it.
 */
export const LINKED_CORE = CORE_PACKAGE;
