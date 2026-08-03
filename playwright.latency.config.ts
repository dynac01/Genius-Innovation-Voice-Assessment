import { defineConfig, devices } from '@playwright/test';

/**
 * The latency harness. Never gated in CI — see docs/TESTING.md §6.
 *
 * The brief asks for a stated target and the measured number. That is a benchmark
 * producing a value, not a pass/fail assertion, and timing on a shared runner is
 * noise. A flaky latency gate gets switched off within a day, taking the real signal
 * with it, so this lives behind its own config and its own script.
 *
 * Chromium's fake media device plays a continuous tone into getUserMedia, which is
 * exactly what a barge-in needs: audio arriving while the assistant is talking.
 */
export default defineConfig({
  testDir: './tests/latency',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,

  use: {
    baseURL: 'http://localhost:5173',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // Chromium's built-in fake device is not a usable stimulus for a detector:
        // it gives no clean silence-then-speech edge to measure against. This file
        // is four seconds of silence, then a speech-shaped burst that lands while
        // the assistant is mid-reply — a barge-in, not a simultaneous start.
        `--use-file-for-fake-audio-capture=${new URL('./tests/latency/fixtures/barge-in.wav', import.meta.url).pathname}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    ...devices['Desktop Chrome'],
  },

  webServer: [
    {
      command: 'pnpm --filter @voice/server start',
      url: 'http://localhost:8787/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @voice/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
