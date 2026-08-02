import { expect, test } from '@playwright/test';

/**
 * Phase 0 smoke — proves the e2e rig itself works, and that a real browser meets
 * the three preconditions the whole demo rests on.
 *
 * This exists now rather than in Phase 9 for the same reason the vertical slice
 * exists on day 1: discovering that the Playwright harness, the fake media device,
 * or the dev server wiring is broken is cheap today and expensive on day six.
 *
 * It grows into the real end-to-end turn test once the loop lands.
 */
test.describe('browser preconditions', () => {
  test('app renders and reports its capability checks', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Voice Conversation' })).toBeVisible();
    await expect(page.getByTestId('capabilities')).toBeVisible();

    // The preconditions for the entire audio path. If any of these is false, no
    // amount of loop correctness produces a working demo — so assert them directly
    // rather than inferring them from a later failure.
    for (const id of ['cap-secure-context', 'cap-get-user-media', 'cap-audio-worklet']) {
      await expect(page.getByTestId(id), `${id} must be satisfied`).toHaveAttribute(
        'data-ok',
        'true',
      );
    }

    // "No silent failures" is an evaluation line in the brief. Catching console
    // errors here means a broken import or a React warning fails the run instead of
    // sitting unnoticed in a tab nobody has open.
    expect(consoleErrors, 'page produced console errors').toEqual([]);
  });
});
