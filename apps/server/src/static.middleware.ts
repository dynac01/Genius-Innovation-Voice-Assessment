import { fileURLToPath } from 'node:url';

import { Injectable, Logger } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { Request, Response } from 'express';

import { createStaticSite } from './static.js';
import type { StaticSite } from './static.js';

/**
 * Serves the built browser app from the same origin as the socket.
 *
 * `ServeStaticModule` would be the reflexive choice here and was rejected on
 * purpose. The existing implementation carries decisions that are tested and worth
 * keeping — SPA fallback that does *not* apply to missing assets, so a typo'd
 * script tag 404s instead of silently returning HTML; rejection of malformed
 * percent-encodings and null bytes; hashed assets cached hard while `index.html` is
 * not cached at all. Swapping tested behaviour for a module's defaults is a
 * downgrade dressed as idiom.
 *
 * What Nest contributes is the mounting, which is all that needed to change.
 */
@Injectable()
export class StaticMiddleware implements NestMiddleware {
  static readonly root =
    process.env['WEB_DIST'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

  readonly #logger = new Logger(StaticMiddleware.name);
  readonly #site: StaticSite = createStaticSite(StaticMiddleware.root);

  get available(): boolean {
    return this.#site.available;
  }

  announce(): void {
    // Whether the app is served from here is the difference between production
    // (one origin) and development (Vite proxies in front). Saying which is
    // cheaper than discovering it from a blank page.
    this.#logger.log(
      this.#site.available
        ? `app served from ${this.#site.root}`
        : `no build at ${this.#site.root} — API only`,
    );
  }

  use(req: Request, res: Response, next: () => void): void {
    /*
     * `originalUrl`, not `url`.
     *
     * Express rewrites `req.url` relative to the mount point, so middleware applied
     * across all routes sees a path stripped of its prefix. Using it here made every
     * request look like the root: a missing asset returned `index.html` with a 200
     * instead of the 404 the fallback rules deliberately produce, which is precisely
     * the "typo'd script tag silently returns HTML" failure those rules exist to stop.
     */
    if (this.#site.serve(req.originalUrl, res)) return;
    next();
  }
}
