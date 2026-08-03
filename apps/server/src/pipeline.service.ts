import { Injectable } from '@nestjs/common';
import type { PipelineAvailability, PipelineSelection } from '@voice/core';
import type { SystemClock } from '@voice/providers';

import {
  assertEnvIsCoherent,
  createPipeline,
  describePipeline,
  providerAvailability,
} from './pipeline.js';
import type { Env, PipelineSetup } from './pipeline.js';

/**
 * Nest's view of provider wiring.
 *
 * Thin on purpose. Every decision about *which* provider to build and whether the
 * configuration is coherent already lives in `pipeline.ts` as pure functions over
 * an `Env` record, tested without a container, a socket, or a process. This class
 * exists to make those functions injectable and to hold the one piece of genuine
 * state — the environment — rather than to re-home the logic.
 *
 * The distinction is worth keeping. Framework code is the least testable code in
 * any project, so the useful question about a service is not "is it small" but "how
 * much reasoning would leave with it if the framework did". Here, none.
 */
@Injectable()
export class PipelineService {
  readonly #env: Env;

  constructor(env: Env = process.env) {
    this.#env = env;
    // Before anything binds a port: a deployment that asked for real providers and
    // cannot have them should refuse to start, not serve fakes while looking healthy.
    assertEnvIsCoherent(this.#env);
  }

  get available(): PipelineAvailability {
    return providerAvailability(this.#env);
  }

  /** Health/banner view: what is configured and what could be. */
  describe(): Record<string, unknown> {
    return describePipeline(this.#env);
  }

  /**
   * Build a pipeline for one session.
   *
   * Per session rather than per process, because provider choice belongs to the
   * browser: criterion 7 asks for the swap to be demonstrable, and a swap that
   * needs a restart is a deployment step rather than a demonstration.
   */
  build(clock: SystemClock, want?: PipelineSelection): PipelineSetup {
    return createPipeline(clock, this.#env, want);
  }
}
