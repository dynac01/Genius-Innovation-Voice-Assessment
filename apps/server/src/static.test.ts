import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createStaticSite } from './static.js';

function buildSite(): string {
  const root = mkdtempSync(join(tmpdir(), 'voice-static-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app-a1b2c3.js'), 'console.log(1)');
  writeFileSync(join(root, 'assets', 'app-a1b2c3.css'), 'body{}');
  return root;
}

describe('static site', () => {
  it('reports unavailable when no build is present', () => {
    const root = mkdtempSync(join(tmpdir(), 'voice-empty-'));
    const site = createStaticSite(root);
    expect(site.available).toBe(false);
    expect(site.match('/')).toBeUndefined();
  });

  it('serves index.html at the root', () => {
    const site = createStaticSite(buildSite());
    expect(site.match('/')?.contentType).toMatch(/text\/html/);
  });

  it.each([
    ['/assets/app-a1b2c3.js', 'text/javascript'],
    ['/assets/app-a1b2c3.css', 'text/css'],
  ])('serves %s with the right content type', (url, type) => {
    const site = createStaticSite(buildSite());
    expect(site.match(url)?.contentType).toMatch(type);
  });

  /**
   * A deploy that left phones on the previous build would be near-impossible to
   * diagnose from a bug report, so the entry point is never cached hard.
   */
  it('caches hashed assets hard and index.html not at all', () => {
    const site = createStaticSite(buildSite());
    expect(site.match('/assets/app-a1b2c3.js')?.cacheControl).toMatch(/immutable/);
    expect(site.match('/')?.cacheControl).toBe('no-cache');
  });

  it('falls back to index.html for app routes', () => {
    const site = createStaticSite(buildSite());
    expect(site.match('/some/deep/route')?.path).toMatch(/index\.html$/);
  });

  /** HTML for a missing script surfaces as a syntax error, not a missing file. */
  it('does not fall back to index.html for a missing asset', () => {
    const site = createStaticSite(buildSite());
    expect(site.match('/assets/missing.js')).toBeUndefined();
  });

  it('ignores the query string', () => {
    const site = createStaticSite(buildSite());
    expect(site.match('/assets/app-a1b2c3.js?v=2')?.contentType).toMatch(/javascript/);
  });

  /** The URL is attacker-controlled even when the app is friendly. */
  it.each([
    '/../package.json',
    '/../../.env',
    '/assets/../../.env',
    '/%2e%2e%2f%2e%2e%2f.env',
    '/%2e%2e/%2e%2e/.env',
  ])('refuses to escape the root via %s', (url) => {
    const site = createStaticSite(buildSite());
    const found = site.match(url);
    // Either refused outright, or absorbed by the SPA fallback — never the file.
    if (found !== undefined) expect(found.path).toMatch(/index\.html$/);
  });

  it('rejects a malformed percent-encoding rather than throwing', () => {
    const site = createStaticSite(buildSite());
    expect(() => site.match('/%E0%A4%A')).not.toThrow();
  });

  it('rejects a null byte in the path', () => {
    const site = createStaticSite(buildSite());
    expect(site.match('/index.html%00.js')).toBeUndefined();
  });
});
