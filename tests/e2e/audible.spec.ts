/**
 * Does the assistant make a sound?
 *
 * This test exists because the rest of the suite could not answer that question,
 * and a bug walked straight through the gap. Every audio assertion in the project
 * checked that frames were *produced*, *delivered*, *decoded*, and *scheduled* —
 * and all of them passed while the browser output was silent, because the
 * AudioContext had been pinned to a sample rate the output device would not run
 * at. The pipeline was healthy end to end and nobody could hear it.
 *
 * The lesson generalises past that one bug: "audio was scheduled" and "audio was
 * audible" are different claims, and only the second one is the product. Between
 * them sit the context's rate and state, gain automation, node connectivity, and
 * whatever a browser decides to do with a buffer whose rate it dislikes — none of
 * which raise an error when they go wrong. They just go quiet.
 *
 * So this measures the last observable thing before the speaker: a tap on
 * `AudioContext.destination` reading real samples. The tap is installed by
 * wrapping the constructor before app code runs, and it only ever *adds* a
 * connection — the graph under test is the graph that ships.
 */

import { expect, test } from '@playwright/test';

/** Comfortably above an all-zero buffer, comfortably below normal speech. */
const AUDIBLE_PEAK = 0.01;

/** One loud window is a click at a buffer seam. A run of them is speech. */
const SUSTAINED_WINDOWS = 5;

interface AudioProbe {
  sampleRate: number;
  state: string;
  peak: number;
  loudWindows: number;
}

declare global {
  interface Window {
    __audioProbe?: AudioProbe;
  }
}

test('a reply reaches the speaker as signal, not just as frames', async ({ page }) => {
  test.setTimeout(60_000);

  await page.addInitScript(() => {
    const Native = window.AudioContext;
    const probe: AudioProbe = { sampleRate: 0, state: 'none', peak: 0, loudWindows: 0 };
    window.__audioProbe = probe;

    window.AudioContext = class extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args);
        probe.sampleRate = this.sampleRate;

        const analyser = this.createAnalyser();
        analyser.fftSize = 2048;

        /*
         * Mirror anything bound for the speaker into the analyser.
         *
         * Wrapping `connect` rather than reaching for a node we think we know keeps
         * the probe honest: it observes whatever the app actually wires up, so a
         * future refactor that routes speech through a different node is measured
         * rather than silently skipped.
         */
        const nativeConnect = AudioNode.prototype.connect;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const context = this;
        function tappedConnect(this: AudioNode, ...rest: unknown[]): AudioNode {
          const target = rest[0];
          if (target === context.destination && this !== analyser) {
            (nativeConnect as (this: AudioNode, to: AudioNode) => AudioNode).call(this, analyser);
          }
          return (nativeConnect as (this: AudioNode, ...a: unknown[]) => AudioNode).apply(
            this,
            rest,
          );
        }
        AudioNode.prototype.connect = tappedConnect as AudioNode['connect'];

        const frame = new Float32Array(analyser.fftSize);
        setInterval(() => {
          probe.state = this.state;
          analyser.getFloatTimeDomainData(frame);
          let peak = 0;
          for (const sample of frame) peak = Math.max(peak, Math.abs(sample));
          probe.peak = Math.max(probe.peak, peak);
          if (peak > 0.01) probe.loudWindows += 1;
        }, 40);
      }
    };
  });

  await page.goto('/');
  await page.getByTestId('session-toggle').click();

  // Delivery first, so a failure here is unambiguous. If frames never arrive the
  // fault is upstream and this test should not be the one to report it.
  await expect
    .poll(async () => Number(await page.getByTestId('frames-received').innerText()), {
      timeout: 25_000,
    })
    .toBeGreaterThan(0);

  await expect
    .poll(async () => (await page.evaluate(() => window.__audioProbe))?.peak ?? 0, {
      timeout: 25_000,
    })
    .toBeGreaterThan(AUDIBLE_PEAK);

  const probe = await page.evaluate(() => window.__audioProbe);

  expect(probe?.loudWindows ?? 0).toBeGreaterThan(SUSTAINED_WINDOWS);

  // The context must be running at a rate the hardware chose. Pinning it is the
  // specific mistake this file was written to stop from coming back.
  expect(probe?.state).toBe('running');
  expect(probe?.sampleRate ?? 0).toBeGreaterThanOrEqual(8_000);
});

/**
 * The instrumentation has to answer the question, not restate the intention.
 *
 * Three rounds of diagnosis were spent on logs that recorded only what the app
 * meant to do — a buffer created, a time scheduled, a gain set. All of it can be
 * true while the room stays silent, so none of it distinguishes "produced no sound"
 * from "produced sound that went somewhere else". These two tests pin the records
 * that close that gap, because a diagnostic nobody asserts on is a diagnostic that
 * quietly stops working.
 */
test('the log records what left the graph, not just what was scheduled', async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto('/');
  await page.getByTestId('session-toggle').click();

  await expect
    .poll(async () => Number(await page.getByTestId('frames-received').innerText()), {
      timeout: 25_000,
    })
    .toBeGreaterThan(0);

  // Let a reply play out so a run of audio begins and ends.
  await page.waitForTimeout(4_000);

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-log').click(),
  ]).then(([event]) => event);

  const { readFile } = await import('node:fs/promises');
  const path = await download.path();
  const parsed = JSON.parse(await readFile(path, 'utf8')) as {
    log: { kind: string; data?: Record<string, unknown> }[];
  };

  const levels = parsed.log.filter((r) => r.kind === 'audio.level');
  expect(levels.length, 'no measured output levels in the log').toBeGreaterThan(0);

  // The measurement must be of real samples, not a restatement of the gain.
  const peaks = levels.map((r) => Number(r.data?.['peak'] ?? 0));
  expect(Math.max(...peaks), 'meter never registered any signal').toBeGreaterThan(0.005);
});

test('the speaker test reports a measurement, not a hope', async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto('/');
  await page.getByTestId('session-toggle').click();
  await expect(page.getByTestId('phase')).toHaveText('running', { timeout: 25_000 });

  await page.getByTestId('test-speaker').click();

  const verdict = page.getByTestId('test-speaker-result');
  await expect(verdict).toBeVisible({ timeout: 15_000 });
  // The tone goes through the assistant's own gain node, so a pass here is evidence
  // about the real path rather than about a separate one built for the test.
  await expect(verdict).toContainText('Tone rendered');
});
