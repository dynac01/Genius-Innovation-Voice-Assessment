import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Control-flow tests run headless against the fakes, with no audio devices and no
    // API keys — that is the whole point of the fakes-first ordering. Keep this suite
    // free of anything that needs a browser or a network.
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    passWithNoTests: false,
    coverage: {
      reporter: ['text', 'html'],
      include: ['packages/*/src/**'],
    },
  },
});
