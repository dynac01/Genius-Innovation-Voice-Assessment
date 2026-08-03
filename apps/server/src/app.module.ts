import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { PipelineService } from './pipeline.service.js';
import { StaticMiddleware } from './static.middleware.js';
import { VoiceGateway } from './voice.gateway.js';

/**
 * The whole backend.
 *
 * Small because the loop is not in it. `@voice/core` owns turn-taking, endpointing,
 * barge-in arbitration and the dialog protocol, and it imports nothing from here —
 * no Nest, no `node:*`, no provider SDK, enforced by `"types": []` and a lint rule
 * rather than by good intentions. This module is the host that drives it.
 *
 * That separation is what made adopting Nest a change to one directory. The
 * framework moved; the loop did not notice.
 */
@Module({
  controllers: [HealthController],
  providers: [PipelineService, VoiceGateway, StaticMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    /*
     * Middleware runs *before* controllers, not after — so without an explicit
     * exclusion the SPA fallback answers `/health` with `index.html` and a 200. A
     * health check that returns the app shell is worse than one that fails: a
     * platform probe reads 200 and calls a broken deployment healthy.
     *
     * Found by curling it rather than by reasoning about it, which is the only
     * reliable way to learn a framework's ordering.
     */
    consumer
      .apply(StaticMiddleware)
      .exclude('health', 'api/health')
      // Both, because `*path` is a named wildcard under path-to-regexp v8 and
      // requires at least one segment — it does not match `/`, which is the one
      // URL every visitor requests first.
      .forRoutes('/', '*path');
  }
}
