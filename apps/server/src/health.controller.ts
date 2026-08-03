import { Controller, Get, Inject } from '@nestjs/common';
import { CORE_PACKAGE } from '@voice/core';
import { PROVIDERS_PACKAGE } from '@voice/providers';

import { PipelineService } from './pipeline.service.js';

/**
 * Health, and the provider availability the browser needs before its first socket.
 *
 * Both paths are served because they answer to different callers: `/health` is what
 * a platform probe hits, `/api/health` is what the app fetches through the Vite dev
 * proxy. Collapsing them would mean the dev proxy needed a rule for a bare `/health`
 * that also matches the app's own routes.
 *
 * The availability half is load-bearing rather than decorative. The UI has to
 * distinguish "this stage has no key" from "we have not asked yet", and rendering
 * the first when it means the second tells someone their configuration is broken
 * when it is fine. That happened. Serving it over HTTP means the answer is known at
 * page load rather than arriving with the first socket `ready`.
 */
@Controller()
export class HealthController {
  /*
   * Injected by explicit token, not by reflected parameter type.
   *
   * `emitDecoratorMetadata` is a TypeScript feature and tsx runs esbuild, which
   * does not implement it. Type-based injection therefore resolves to `undefined`
   * at runtime while compiling and starting perfectly — the controller only fails
   * when a request arrives. Naming the token removes the dependency on a compiler
   * feature this runtime does not have.
   */
  constructor(@Inject(PipelineService) private readonly pipelines: PipelineService) {}

  @Get(['health', 'api/health'])
  health(): Record<string, unknown> {
    return {
      status: 'ok',
      packages: [CORE_PACKAGE, PROVIDERS_PACKAGE],
      pipeline: this.pipelines.describe(),
    };
  }
}
