import { expect, test } from '@playwright/test';

/**
 * Phase 2's risk gate, automated.
 *
 * Microphone in, WebSocket out, fake pipeline, audio back — in a real browser, with
 * a real AudioWorklet and a real socket. Chromium's fake media device feeds
 * getUserMedia, so the capture path under test is the production one; only the
 * sound source is synthetic.
 *
 * What this cannot cover is the other half of the gate: iOS Safari's AudioContext
 * and playback on a physical phone. Those stay manual, and the workplan says so.
 */
test.describe('vertical slice round trip', () => {
  test('captures, streams, and plays server audio back', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/');
    await page.getByTestId('session-toggle').click();

    // The socket opened and the server acknowledged the session.
    await expect(page.getByTestId('phase')).toHaveText('running', { timeout: 15_000 });

    // Independent of the socket: `running` comes from the server's ready event, so it
    // says nothing about the microphone. On a cold Vite start the capture path can
    // take longer than the default 5s expect timeout, so give it the same budget as
    // everything else here rather than letting the suite pass on the second run.
    await expect(page.getByTestId('permission')).toHaveText('granted', { timeout: 15_000 });

    // Microphone audio is reaching the server.
    await expect
      .poll(async () => Number(await page.getByTestId('frames-sent').innerText()), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    // The pipeline ran: a final transcript, then a streamed reply — as two
    // separate turns in a conversation, not one accumulating blob.
    await expect(page.getByTestId('turn-user').last()).toContainText('what is the weather today', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('turn-assistant').last()).toContainText('sunny', {
      timeout: 20_000,
    });

    // Assistant audio came back down the socket and was handed to the audio graph.
    await expect
      .poll(async () => Number(await page.getByTestId('frames-received').innerText()), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    // A latency number exists to record — Phase 2 asks for a measured baseline.
    await expect(page.getByTestId('response-latency')).not.toHaveText('—');

    // Earcons actually reached the audio graph rather than merely being logged.
    // Their *shape* is asserted in the unit tier; what a browser adds is proof that
    // Web Audio accepted them without throwing.
    await expect
      .poll(async () => Number(await page.getByTestId('earcon-count').innerText()), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId('last-earcon')).toHaveText('ready');

    expect(consoleErrors, 'page produced console errors').toEqual([]);
  });

  /**
   * The failure this replaces: user and assistant text were two accumulating
   * strings, so a second turn appended to the first and the transcript became one
   * unreadable blob with no speaker or turn boundaries.
   */
  test('renders the exchange as separate, attributed turns', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('session-toggle').click();

    await expect(page.getByTestId('turn-assistant').last()).toContainText('sunny', {
      timeout: 25_000,
    });

    const turns = page.locator('[data-role]');
    expect(await turns.count()).toBeGreaterThanOrEqual(2);

    // Each turn carries its own speaker, and the user's comes first.
    expect(await turns.first().getAttribute('data-role')).toBe('user');
    expect(await turns.last().getAttribute('data-role')).toBe('assistant');

    // The assistant's turn holds only its own reply, not the user's words too.
    await expect(page.getByTestId('turn-assistant').last()).not.toContainText(
      'what is the weather',
    );
  });

  test('stopping the session releases the microphone', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('session-toggle').click();
    await expect(page.getByTestId('phase')).toHaveText('running', { timeout: 15_000 });

    await page.getByTestId('session-toggle').click();
    await expect(page.getByTestId('phase')).toHaveText('idle');
    await expect(page.getByTestId('session-toggle')).toHaveText('Start session');
  });
});
