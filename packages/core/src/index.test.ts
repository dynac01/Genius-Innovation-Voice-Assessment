import { describe, expect, it } from 'vitest';

import { CORE_PACKAGE, CORE_STATUS } from './index.js';

describe('@voice/core scaffold', () => {
  it('exports its package identity', () => {
    expect(CORE_PACKAGE).toBe('@voice/core');
  });

  it('reports its build-out status', () => {
    expect(CORE_STATUS).toBe('scaffold');
  });
});
