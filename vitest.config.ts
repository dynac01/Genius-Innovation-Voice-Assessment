import { defineConfig } from 'vitest/config';

/**
 * Two tiers run here; a third runs elsewhere. See docs/TESTING.md.
 *
 *   unit     — pure logic, colocated with source as src/**\/*.test.ts
 *   feature  — the loop's control flow driven through the fakes, in tests/feature
 *   e2e      — Playwright, tests/e2e/**\/*.spec.ts, NOT run by Vitest
 *
 * The `.test.ts` / `.spec.ts` split is what keeps Vitest and Playwright from
 * collecting each other's files.
 *
 * Everything here is headless and keyless: no audio devices, no browser, no API
 * keys, no network. That is the point of the fakes-first ordering — CI proves the
 * loop's behaviour without live audio or a paid provider.
 *
 * Note on client-side audio code: there is deliberately no jsdom project. jsdom does
 * not implement Web Audio, and mocking it would test the mock. Instead the decision
 * logic lives as pure functions in @voice/core (unit-tested here) and the Web Audio
 * adapter in apps/web stays thin enough to carry no logic worth asserting. What the
 * adapter does get is e2e coverage in a real browser.
 */
export default defineConfig({
  test: {
    // A run that collects nothing is a failure, not a pass. Silently-zero test runs
    // are how a broken include glob goes unnoticed for a week.
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'feature',
          environment: 'node',
          include: ['tests/feature/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Coverage is meaningful for the loop and its state machines. Transport
      // adapters and the browser shell are covered by e2e, not by line count.
      include: ['packages/core/src/**', 'packages/providers/src/**'],
    },
  },
});
