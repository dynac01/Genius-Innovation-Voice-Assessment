/**
 * The session log has to survive being handed to someone else.
 *
 * A diagnostic that only works while you are standing next to it is not a
 * diagnostic. So this test does what a person reporting a fault would do — run a
 * session, press the button, open the file — and then asserts the things a reader
 * would need to answer the questions that have actually come up: what rate was the
 * browser capturing at, what rate did it declare, did the server agree, did audio
 * get scheduled, and was the output muted at the time.
 *
 * The specific value here is that these fields are checked *together*. Every fault
 * this file exists because of was a mismatch between two individually-plausible
 * numbers, which is the one thing a single-sided log can never show you.
 */

import { expect, test } from '@playwright/test';

interface LogFile {
  capturedAt: string;
  userAgent: string;
  records: number;
  dropped: number;
  engine: Record<string, unknown>;
  state: Record<string, unknown>;
  conversation: unknown[];
  log: { t: number; source: 'browser' | 'server'; kind: string; data?: unknown }[];
}

test('the downloaded log carries both sides of the session', async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto('/');
  await page.getByTestId('session-toggle').click();

  // Wait for a full round trip so the log has something to be a log of.
  await expect
    .poll(async () => Number(await page.getByTestId('frames-received').innerText()), {
      timeout: 25_000,
    })
    .toBeGreaterThan(0);

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-log').click(),
  ]).then(([event]) => event);

  const path = await download.path();
  expect(path).not.toBeNull();

  const { readFile } = await import('node:fs/promises');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as LogFile;

  // --- the header a reader sees first -------------------------------------

  expect(parsed.userAgent).toContain('Mozilla');
  expect(parsed.records).toBeGreaterThan(0);
  expect(parsed.log.length).toBe(parsed.records);

  // --- both halves are present --------------------------------------------

  const browser = parsed.log.filter((r) => r.source === 'browser');
  const server = parsed.log.filter((r) => r.source === 'server');
  expect(browser.length).toBeGreaterThan(0);
  expect(
    server.length,
    'server diagnostics must be relayed, not left in a terminal',
  ).toBeGreaterThan(0);

  // --- the rate agreement, which is the fault this was built for -----------

  const hello = browser.find((r) => r.kind === 'send.hello')?.data as { sampleRate: number };
  const serverHello = server.find((r) => r.kind === 'session.hello')?.data as {
    announcedRate: number;
    usingRate: number;
    assumed: boolean;
  };

  expect(hello.sampleRate, 'the browser must declare a rate it measured').toBeGreaterThan(0);
  expect(serverHello.assumed, 'the server must not be guessing the capture rate').toBe(false);
  expect(serverHello.usingRate).toBe(hello.sampleRate);
  expect(parsed.engine['sampleRate']).toBe(hello.sampleRate);

  // --- audio was scheduled, and into an audible node ------------------------

  const played = browser.find((r) => r.kind === 'audio.play')?.data as {
    gain: number;
    contextState: string;
    contextRate: number;
  };
  expect(played, 'a reply must produce at least one scheduling record').toBeDefined();
  expect(played.contextState).toBe('running');
  expect(
    played.gain,
    'audio scheduled into a muted node is the silent-failure case',
  ).toBeGreaterThan(0);

  // --- ordering is usable ---------------------------------------------------

  const times = parsed.log.map((r) => r.t);
  expect(times).toEqual([...times].sort((a, b) => a - b));
});

test('the log survives a stop, because stopping is what people do first', async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto('/');
  await page.getByTestId('session-toggle').click();
  await expect
    .poll(async () => Number(await page.getByTestId('frames-sent').innerText()), {
      timeout: 25_000,
    })
    .toBeGreaterThan(0);

  await page.getByTestId('session-toggle').click();
  await expect(page.getByTestId('phase')).toHaveText('idle');

  // The records outlive the session they describe.
  await expect(page.getByTestId('download-log')).toBeEnabled();
});
