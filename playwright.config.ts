import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tier — a real browser driving the real app. See docs/TESTING.md.
 *
 * Deliberately thin. This tier proves the seams hold end to end: the page loads,
 * mic permission is granted, the socket connects, a full turn completes on the
 * fakes, and the transcript renders both sides. It asserts nothing about audio
 * quality or latency — audio e2e assertions are where flakiness lives, and the
 * numbers that matter come from the latency harness instead.
 *
 * The microphone is faked at the browser level, not mocked in application code:
 * Chromium's --use-fake-device-for-media-stream feeds a WAV file to getUserMedia,
 * so the capture path under test is the real one.
 */
const isCI = !!process.env['CI'];

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // Left to Playwright's default off CI. `exactOptionalPropertyTypes` means an
  // explicit `undefined` is not the same as omitting the key, so this is spread in
  // conditionally rather than assigned.
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI ? ([['github'], ['html', { open: 'never' }]] as const) : ([['list']] as const),

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Grant the mic up front so the permission prompt never blocks a run. The
        // prompt itself is exercised by hand and in the recorded demo — it is UI,
        // not control flow.
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],

  // Both halves of the slice: the API/socket host and the browser app. Vite proxies
  // /ws through to the server, so the browser only ever talks to one origin.
  webServer: [
    {
      command: 'pnpm --filter @voice/server start',
      url: 'http://localhost:8787/health',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @voice/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
