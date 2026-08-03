import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER_PORT = Number(process.env['PORT'] ?? 8787);

/**
 * Codespaces forwards a port by putting a proxy in front of it, so requests arrive
 * with a `Host` of `<name>-5173.app.github.dev` rather than `localhost`.
 *
 * Vite refuses those by default — a DNS-rebinding guard, and a correct one. The
 * symptom is not subtle but it is easy to misread: every request, including the page
 * itself, comes back `403 Blocked request. This host is not allowed.`, which looks
 * like a broken container rather than one missing config line. The brief requires
 * the project to run in Codespaces, so without this it fails that outright.
 *
 * Allowed by domain rather than by disabling the check. `allowedHosts: true` would
 * also work and would switch the protection off for every host — a large concession
 * for a requirement that names exactly one platform.
 */
const CODESPACES_HOSTS = ['.app.github.dev', '.github.dev'];

/**
 * Hot reload has to be told the *public* port, not the local one.
 *
 * A forwarded URL carries no port — it is plain HTTPS on 443 — so Vite's client
 * would otherwise open its reload socket against `:5173` on a host that does not
 * publish it. The app itself still runs; edits simply stop refreshing while the
 * console fills with connection errors, which is a poor way to spend an hour.
 */
const inCodespaces = process.env['CODESPACES'] === 'true';

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true binds 0.0.0.0 so GitHub Codespaces (and any container) can forward
    // the port. Codespaces serves forwarded ports over HTTPS, which makes the page a
    // secure context — required for getUserMedia. That is why the demo is developable
    // in a Codespace at all.
    host: true,
    port: 5173,
    allowedHosts: CODESPACES_HOSTS,
    ...(inCodespaces ? { hmr: { clientPort: 443, protocol: 'wss' } } : {}),
    proxy: {
      '/api': { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true },
      // The socket is proxied through the same origin as the page on purpose. In a
      // Codespace that means one forwarded port carries both, so the browser reaches
      // `wss://<name>-5173.app.github.dev/ws` and the server's port never needs
      // publishing separately — which would be a second origin, and cross-origin.
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
});
