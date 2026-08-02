/**
 * @voice/core — the reusable voice loop.
 *
 * This package holds the loop, the pluggable pipeline interfaces, the bridge/dialog
 * protocol, and the turn + barge-in state machines. It performs no I/O: no network,
 * no filesystem, no audio devices, no timers it does not own. Everything that talks
 * to the outside world lives in @voice/providers or the apps.
 *
 * That constraint is enforced three ways:
 *   - `"types": []` in tsconfig.json, so Node's globals are not even in scope
 *   - a `no-restricted-imports` ESLint rule banning `node:*` and provider SDKs
 *   - this package declaring zero runtime dependencies
 *
 * Contracts land in Phase 1; see docs/WORKPLAN.md.
 */

/** Identifies this package across the workspace. Used to verify workspace wiring. */
export const CORE_PACKAGE = '@voice/core' as const;

/** Semantic marker for the phase of the build-out this package has reached. */
export const CORE_STATUS = 'scaffold' as const;
