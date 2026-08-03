/**
 * @voice/server — transport and session host.
 *
 * This process owns HTTP, the WebSocket, session lifecycle and provider wiring. It
 * does not own the loop: that lives in `@voice/core` and is driven from here.
 * Keeping the split honest is what lets the same loop be driven by something other
 * than a browser — and it is why moving this file to Nest touched no logic.
 */

import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { describePipeline } from './pipeline.js';
import { StaticMiddleware } from './static.middleware.js';
import { RawWsAdapter } from './ws-adapter.js';

/**
 * Node reads .env natively, so provider keys need no dependency and no bundler
 * step. The search walks upward because the server is normally started from its
 * own package directory (`pnpm --filter @voice/server dev`) while .env lives at the
 * repo root — a cwd-relative lookup silently finds nothing and the app quietly
 * falls back to fakes, which looks like a broken key rather than a missing file.
 * Absent .env is still the normal case: no keys, all fakes.
 *
 * Runs before the module graph is built, because `PipelineService` reads the
 * environment in its constructor and refuses to start on an incoherent one.
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

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // The app's own logger, so the banner and per-session lines read as one stream.
    logger: ['error', 'warn', 'log'],
  });

  // Message routing disabled: audio is binary and control is bare JSON, neither of
  // which fits Nest's `{ event, data }` envelope. See RawWsAdapter.
  app.useWebSocketAdapter(new RawWsAdapter(app));

  await app.listen(PORT, HOST);

  const logger = new Logger('bootstrap');
  const { default: def, available } = describePipeline(process.env) as {
    default: Record<string, string>;
    available: Record<string, boolean>;
  };
  logger.log(`http://${HOST}:${PORT}  (health: /health, socket: /ws)`);
  logger.log(
    `default  stt=${def['stt']}  llm=${def['llm']}  tts=${def['tts']}` +
      `   (real available: stt=${available['stt']} llm=${available['llm']} tts=${available['tts']})`,
  );
  logger.log('the browser can change any of these per session');
  app.get(StaticMiddleware).announce();
}

void bootstrap();
