import { randomUUID } from 'node:crypto';

import { Inject, Logger } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { decodeAudioFrame, isClientEvent } from '@voice/core';
import { SystemClock } from '@voice/providers';
import type { RawData, WebSocket } from 'ws';

import { PipelineService } from './pipeline.service.js';
import { Session } from './session.js';

/**
 * The socket end of the loop.
 *
 * What this class does *not* do is the point of it: no turn logic, no endpointing,
 * no barge-in arbitration, no opinion about what the assistant should say. Those
 * live in `AudioBridge` and the dialog inside `@voice/core`, driven from here. This
 * is a transport boundary, and keeping it one is what allows the same loop to be
 * driven by something that is not a browser — a test harness already does exactly
 * that, with no gateway involved.
 *
 * Message handling is attached directly to the client rather than routed through
 * `@SubscribeMessage`, because the protocol carries binary audio and bare JSON
 * rather than Nest's `{ event, data }` envelope. See `RawWsAdapter` for why that is
 * the right way round.
 */
@WebSocketGateway({ path: '/ws' })
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  readonly #logger = new Logger(VoiceGateway.name);
  /**
   * One session per socket, keyed by the socket itself.
   *
   * A `WeakMap` so a dropped connection cannot leak a session: if the socket is
   * collected without a clean `close`, the entry goes with it. `handleDisconnect`
   * is still the normal path — this only removes the failure mode where it is not.
   */
  readonly #sessions = new WeakMap<WebSocket, Session>();

  // Explicit token: esbuild does not emit decorator metadata. See HealthController.
  constructor(@Inject(PipelineService) private readonly pipelines: PipelineService) {}

  handleConnection(socket: WebSocket): void {
    const sessionId = randomUUID().slice(0, 8);
    const clock = new SystemClock();

    const session = new Session({
      sessionId,
      clock,
      // Built when the browser says what it wants, not up front.
      buildPipeline: (want) => this.pipelines.build(clock, want),
      available: this.pipelines.available,
      send: (payload) => {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      },
      log: (message) => this.#logger.log(message),
    });

    this.#sessions.set(socket, session);
    this.#logger.log(`${sessionId} connected`);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary) {
          session.handleAudio(decodeAudioFrame(toArrayBuffer(data)).pcm);
          return;
        }
        const parsed: unknown = JSON.parse(data.toString());
        if (!isClientEvent(parsed)) {
          this.#logger.warn(`${sessionId} ignored unrecognised event`);
          return;
        }
        session.handleEvent(parsed);
      } catch (error) {
        this.#logger.error(`${sessionId} message failed`, error as Error);
      }
    });

    socket.on('error', (error: Error) => {
      this.#logger.error(`${sessionId} socket error`, error);
    });
  }

  handleDisconnect(socket: WebSocket): void {
    const session = this.#sessions.get(socket);
    if (session === undefined) return;
    session.close();
    this.#sessions.delete(socket);
    this.#logger.log('disconnected');
  }
}

/** `ws` hands us a Buffer, a Buffer[], or an ArrayBuffer depending on the frame. */
function toArrayBuffer(data: RawData): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (Array.isArray(data)) return toArrayBuffer(Buffer.concat(data));

  // A Node Buffer may be a view onto a pooled — and possibly shared — allocation,
  // so copy out the exact window rather than handing on a reference to the pool.
  const buffer = data as Buffer;
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  return copy;
}
