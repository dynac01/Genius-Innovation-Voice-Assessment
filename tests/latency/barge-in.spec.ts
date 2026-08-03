import { expect, test } from '@playwright/test';

/**
 * Measures the number the brief singles out: user speech onset → assistant audio
 * silent. Reports it rather than asserting a threshold, because that is what a
 * benchmark is for.
 *
 * The one assertion here is a sanity floor — a measurement wildly outside any
 * plausible range means the instrument is broken, not that the system is slow.
 */
test('barge-in stop latency', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('session-toggle').click();
  await expect(page.getByTestId('phase')).toHaveText('running', { timeout: 20_000 });

  // Wait until the assistant is actually speaking — barge-in is only meaningful
  // while there is something to cut off.
  await expect(page.getByTestId('turn')).toHaveText('speaking', { timeout: 25_000 });

  // The fake media device is a continuous tone, so the detector trips on its own
  // once output is live. That is the barge-in.
  await expect
    .poll(async () => Number(await page.getByTestId('barge-in-count').innerText()), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  const measured = Number((await page.getByTestId('barge-in-ms').innerText()).replace(' ms', ''));
  const responded = await page.getByTestId('response-latency').innerText();

  console.log('');
  console.log('  ── measured ────────────────────────────────');
  console.log(`  barge-in stop (onset → silent) : ${measured} ms   target < 300`);
  console.log(`  final transcript → first audio : ${responded}`);
  console.log('  ────────────────────────────────────────────');
  console.log('');

  // Sanity floor only: outside this range the instrument is wrong, not the system.
  expect(measured).toBeGreaterThan(0);
  expect(measured).toBeLessThan(2_000);
});
