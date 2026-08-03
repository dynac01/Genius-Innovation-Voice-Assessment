/**
 * @voice/server — transport and session host.
 *
 * This process owns the WebSocket, session lifecycle, and provider wiring. It does
 * not own the loop: that lives in @voice/core and is driven from here. Keeping the
 * split honest is what lets the same loop be driven by something other than a browser.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { CORE_PACKAGE, decodeAudioFrame, isClientEvent } from '@voice/core';
import { PROVIDERS_PACKAGE, SystemClock } from '@voice/providers';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import { createPipeline } from './pipeline.js';
import { Session } from './session.js';

const PORT = Number(process.env['PORT'] ?? 8787);
const HOST = process.env['HOST'] ?? '0.0.0.0';

const server = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', packages: [CORE_PACKAGE, PROVIDERS_PACKAGE] }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket: WebSocket) => {
  const sessionId = randomUUID().slice(0, 8);
  const session = new Session({
    sessionId,
    pipeline: createPipeline(new SystemClock(), process.env),
    send: (payload) => {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    },
    log: (message) => console.log(`[ws] ${message}`),
  });

  console.log(`[ws] ${sessionId} connected`);

  socket.on('message', (data: RawData, isBinary: boolean) => {
    try {
      if (isBinary) {
        const frame = decodeAudioFrame(toArrayBuffer(data));
        session.handleAudio({ pcm: frame.pcm, sampleRate: 0 });
        return;
      }
      const parsed: unknown = JSON.parse(data.toString());
      if (!isClientEvent(parsed)) {
        console.warn(`[ws] ${sessionId} ignored unrecognised event`);
        return;
      }
      session.handleEvent(parsed);
    } catch (error) {
      console.error(`[ws] ${sessionId} message failed:`, error);
    }
  });

  socket.on('close', () => {
    session.close();
    console.log(`[ws] ${sessionId} disconnected`);
  });
  socket.on('error', (error) => console.error(`[ws] ${sessionId} socket error:`, error));
});

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

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT}  (health: /health, socket: /ws)`);
});
