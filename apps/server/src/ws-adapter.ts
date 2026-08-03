import { WsAdapter } from '@nestjs/platform-ws';

/**
 * A `ws` adapter that stays out of the message path.
 *
 * Nest's gateway model assumes a request/response protocol: every frame is JSON
 * shaped `{ event, data }`, the adapter parses it, and `@SubscribeMessage('name')`
 * dispatches on the event field. That is a good fit for most WebSocket APIs and a
 * bad one for this protocol, in two ways that cannot be papered over.
 *
 * Audio travels as **binary** frames — raw PCM, fifty a second, no envelope. Base64
 * would cost a third of the highest-volume traffic in the system for the privilege
 * of looking like JSON. The stock adapter calls `JSON.parse` on every message, so
 * every audio frame would throw.
 *
 * Control travels as **bare** JSON — `{ type: 'hello', ... }` — because the wire
 * format is documented in `@voice/core` and shared with the browser, which has no
 * Nest in it. Wrapping it in a second envelope to satisfy a dispatcher on one side
 * would put a framework's convention into a contract that belongs to neither end.
 *
 * So message binding is disabled and the gateway reads its own socket. Everything
 * else the adapter does — creating the server, binding it to the right path,
 * driving connect and disconnect into Nest's lifecycle — is kept, because that part
 * genuinely is the framework's job.
 *
 * The alternative was to reshape the protocol to suit the transport layer. That is
 * the wrong way round: the wire format is a design decision with reasons behind it,
 * and the framework is an implementation detail of one side of it.
 */
export class RawWsAdapter extends WsAdapter {
  /**
   * Deliberately empty.
   *
   * The base implementation attaches a `message` listener that parses JSON and
   * dispatches to `@SubscribeMessage` handlers. Leaving it attached would mean two
   * listeners on the same socket, one of which throws on every audio frame.
   */
  override bindMessageHandlers(): void {
    // The gateway owns `message`. See the class comment.
  }
}
