import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * Serves the built browser app from the same origin as the WebSocket.
 *
 * In development Vite serves the app and proxies `/ws` to this process. In
 * production there is one container and one origin, which is not merely tidier:
 * a second origin would make the socket cross-origin and put the demo one CORS
 * or cookie policy away from failing on exactly the mobile browsers it needs to
 * work on. Same origin also means one certificate and one HTTPS URL to hand over.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** What a request resolves to. Deciding this is separate from streaming it. */
export interface StaticMatch {
  readonly path: string;
  readonly contentType: string;
  readonly cacheControl: string;
}

export interface StaticSite {
  readonly root: string;
  /** True when a build is actually present — otherwise the server is API-only. */
  readonly available: boolean;
  /** Resolve a URL to a file, or `undefined` if it does not map to one. */
  match(url: string): StaticMatch | undefined;
  /** Resolve and stream. Returns false when the URL is not ours to answer. */
  serve(url: string, res: ServerResponse): boolean;
}

export function createStaticSite(root: string): StaticSite {
  const absoluteRoot = resolve(root);
  const available = existsSync(join(absoluteRoot, 'index.html'));

  const match = (url: string): StaticMatch | undefined => {
    if (!available) return undefined;

    const requested = url.split('?')[0] ?? '/';
    const file = resolveWithinRoot(absoluteRoot, requested);

    // A single-page app owns its routing, so anything that is not a real file
    // falls back to index.html rather than 404ing. Assets are the exception:
    // returning HTML for a missing script would surface as a baffling syntax
    // error instead of a missing file.
    const path =
      file !== undefined && isFile(file)
        ? file
        : extname(requested) === ''
          ? join(absoluteRoot, 'index.html')
          : undefined;

    if (path === undefined) return undefined;

    return {
      path,
      contentType: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      // Hashed asset filenames are safe to cache hard; index.html must not be, or
      // a deploy would leave phones running the previous build indefinitely.
      cacheControl: path.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    };
  };

  return {
    root: absoluteRoot,
    available,
    match,

    serve(url: string, res: ServerResponse): boolean {
      const found = match(url);
      if (found === undefined) return false;
      res.writeHead(200, {
        'content-type': found.contentType,
        'cache-control': found.cacheControl,
      });
      createReadStream(found.path).pipe(res);
      return true;
    },
  };
}

/**
 * Resolve a request path inside the root, or `undefined` if it escapes.
 *
 * The URL is attacker-controlled even when the app is friendly, so `..`,
 * absolute paths, and encoded traversal are all rejected by comparing the
 * resolved path against the root rather than by pattern-matching the input.
 */
function resolveWithinRoot(root: string, requested: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;

  const candidate = resolve(join(root, normalize(decoded)));
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
  return candidate;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
