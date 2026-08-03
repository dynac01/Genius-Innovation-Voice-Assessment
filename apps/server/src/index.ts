/**
 * @voice/server — transport and session host.
 *
 * This process owns the WebSocket, session lifecycle, and provider wiring. It does
 * not own the loop: that lives in @voice/core and is driven from here. Keeping the
 * split honest is what lets the same loop be driven by something other than a browser.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CORE_PACKAGE, decodeAudioFrame, isClientEvent } from '@voice/core';
import { PROVIDERS_PACKAGE, SystemClock } from '@voice/providers';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import { createPipeline, describePipeline } from './pipeline.js';
import { Session } from './session.js';

/**
 * Node reads .env natively, so provider keys need no dependency and no bundler
 * step. The search walks upward because the server is normally started from its
 * own package directory (`pnpm --filter @voice/server dev`) while .env lives at
 * the repo root — a cwd-relative lookup silently finds nothing and the app
 * quietly falls back to fakes, which looks like a broken key rather than a
 * missing file. Absent .env is still the normal case: no keys, all fakes.
 */
function loadEnvFromAncestors(): void {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
loadEnvFromAncestors();

const PORT = Number(process.env['PORT'] ?? 8787);
const HOST = process.env['HOST'] ?? '0.0.0.0';

const server = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        packages: [CORE_PACKAGE, PROVIDERS_PACKAGE],
        pipeline: describePipeline(process.env),
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket: WebSocket) => {
  const sessionId = randomUUID().slice(0, 8);
  const clock = new SystemClock();
  const { pipeline, dialog } = createPipeline(clock, process.env);
  const session = new Session({
    sessionId,
    clock,
    pipeline,
    dialog,
    send: (payload) => {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    },
    log: (message) => console.log(`[ws] ${message}`),
  });

  console.log(`[ws] ${sessionId} connected`);

  socket.on('message', (data: RawData, isBinary: boolean) => {
    try {
      if (isBinary) {
        session.handleAudio(decodeAudioFrame(toArrayBuffer(data)).pcm);
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
  const pipeline = describePipeline(process.env);
  console.log(`[server] http://${HOST}:${PORT}  (health: /health, socket: /ws)`);
  console.log(
    `[server] pipeline  stt=${pipeline['stt']}  llm=${pipeline['llm']}  tts=${pipeline['tts']}`,
  );
});
