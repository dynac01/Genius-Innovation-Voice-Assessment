/**
 * @voice/server — transport and session host.
 *
 * This process owns the WebSocket, session lifecycle, and provider wiring. It does
 * not own the loop: that lives in @voice/core and is driven from here. Keeping the
 * split honest is what lets the same loop be driven by something other than a browser.
 *
 * Phase 0 is a health endpoint only. The WebSocket lands in Phase 2.
 */

import { createServer } from 'node:http';

import { CORE_PACKAGE, CORE_STATUS } from '@voice/core';
import { PROVIDERS_PACKAGE } from '@voice/providers';

const PORT = Number(process.env['PORT'] ?? 8787);
const HOST = process.env['HOST'] ?? '0.0.0.0';

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        phase: CORE_STATUS,
        packages: [CORE_PACKAGE, PROVIDERS_PACKAGE],
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT} (health: /health)`);
});
