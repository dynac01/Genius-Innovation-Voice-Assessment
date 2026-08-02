import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER_PORT = Number(process.env['PORT'] ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true binds 0.0.0.0 so GitHub Codespaces (and any container) can forward
    // the port. Codespaces serves forwarded ports over HTTPS, which makes the page a
    // secure context — required for getUserMedia. That is why the demo is developable
    // in a Codespace at all.
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
});
