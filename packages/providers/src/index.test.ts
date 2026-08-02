import { describe, expect, it } from 'vitest';

import { LINKED_CORE, PROVIDERS_PACKAGE } from './index.js';

describe('@voice/providers scaffold', () => {
  it('exports its package identity', () => {
    expect(PROVIDERS_PACKAGE).toBe('@voice/providers');
  });

  // The real assertion of this suite: a workspace package can resolve and import
  // from another. If pnpm linking or the TS module resolution is misconfigured,
  // this fails at import time rather than silently later.
  it('resolves @voice/core across the workspace', () => {
    expect(LINKED_CORE).toBe('@voice/core');
  });
});
