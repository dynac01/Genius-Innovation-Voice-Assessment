/**
 * The bridge ↔ dialog protocol.
 *
 * Fixed by the brief and reproduced exactly. The audio bridge implements one side;
 * a dialog implements the other. Because the wire shape is frozen, the stub dialog
 * shipped here can be replaced by a real decision engine without the bridge
 * knowing, which is the point of having a protocol rather than a function call.
 */

/** Bridge → dialog. */
export type FromBridge =
  | { type: 'utterance'; text: string; t: number }
  | { type: 'pause_detected'; t: number }
  | { type: 'interrupt'; t: number }; // user started talking over the assistant

/** Dialog → bridge. */
export type ToBridge =
  | { type: 'say'; text: string }
  | { type: 'earcon'; sound: 'listening' | 'accepted' | 'ready' | 'failed' }
  | { type: 'barge_in'; behavior: 'stop' | 'pause' | 'finish' };

/** The four state sounds. */
export type EarconSound = Extract<ToBridge, { type: 'earcon' }>['sound'];

/** What an interruption should do to the reply in flight. */
export type BargeInBehavior = Extract<ToBridge, { type: 'barge_in' }>['behavior'];

/**
 * The dialog side of the protocol.
 *
 * Duplex and streaming, mirroring the pipeline interfaces: events go in, commands
 * come out, and the two are not paired one-to-one — a single utterance may produce
 * an earcon and a `say`, and a dialog may emit nothing at all for a `pause_detected`.
 *
 * Implemented by the stub in Phase 5.
 */
export interface Dialog {
  connect(events: AsyncIterable<FromBridge>): AsyncIterable<ToBridge>;
}
