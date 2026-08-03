import { devices, expect, test } from '@playwright/test';

/**
 * The brief requires the demo to work "in mobile browsers as well as desktop".
 *
 * What a viewport test can prove is layout and reachability: nothing overflows,
 * the control is thumb-sized, the preconditions are visible without scrolling
 * past them. What it cannot prove is the two things that actually break on
 * phones — iOS Safari's AudioContext gesture rule, and echo through a
 * speakerphone — because no desktop browser is an iPhone. Those stay manual, and
 * the workplan says so rather than letting a green tick imply otherwise.
 *
 * Chromium at an iPhone viewport rather than WebKit, deliberately. WebKit is
 * Safari's engine and would catch more CSS differences, but the failures that
 * actually bite on iOS are in the audio stack — which desktop WebKit does not
 * reproduce faithfully either. So it would buy layout fidelity we can mostly get
 * for free, at the cost of a second browser download in CI, while leaving the
 * real risk exactly as manual as it already is.
 */
test.use({ ...devices['iPhone 13'], browserName: 'chromium' });

test.describe('mobile layout', () => {
  test('fits a phone viewport without horizontal scroll', async ({ page }) => {
    await page.goto('/');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'page scrolls sideways on a phone').toBeLessThanOrEqual(0);
  });

  test('gives the session control a thumb-sized target', async ({ page }) => {
    await page.goto('/');
    const box = await page.getByTestId('session-toggle').boundingBox();

    expect(box).not.toBeNull();
    // Apple's minimum is 44pt; anything smaller is a mis-tap waiting to happen.
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThan(200);
  });

  test('shows the capability checks above the fold', async ({ page }) => {
    await page.goto('/');
    const checks = await page.getByTestId('capabilities').boundingBox();
    const viewport = page.viewportSize();

    expect(checks).not.toBeNull();
    expect(checks!.y + checks!.height).toBeLessThan(viewport!.height);
  });

  test('reports a secure context and a usable audio stack', async ({ page }) => {
    await page.goto('/');
    for (const id of ['cap-secure-context', 'cap-get-user-media', 'cap-audio-worklet']) {
      await expect(page.getByTestId(id)).toHaveAttribute('data-ok', 'true');
    }
  });

  test('runs a full turn on a phone-sized viewport', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('session-toggle').click();

    await expect(page.getByTestId('phase')).toHaveText('running', { timeout: 20_000 });
    await expect(page.getByTestId('connection')).toHaveText('open');
    await expect(page.getByTestId('turn-user').last()).toContainText('what is the weather today', {
      timeout: 25_000,
    });
    await expect
      .poll(async () => Number(await page.getByTestId('frames-received').innerText()), {
        timeout: 25_000,
      })
      .toBeGreaterThan(0);
  });
});
