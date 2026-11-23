import { describe, expect, it } from 'vitest';
import { isStaleChunkError } from '../src/pwa.ts';

describe('stale chunk detection', () => {
  it('recognises failed lazy imports in Chrome, Safari and Firefox', () => {
    expect(
      isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: /assets/x.js')),
    ).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunkError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isStaleChunkError(new Error('Network request failed'))).toBe(false);
  });
});
