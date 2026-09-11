import { describe, expect, it } from 'vitest';
import { deflateUpperBound } from './transfer-source';

describe('deflateUpperBound', () => {
  it('bounds input above its own size, because deflate can grow it', () => {
    // Incompressible input comes out larger, so a bound at `size` would be
    // wrong exactly when the wire ceiling matters.
    expect(deflateUpperBound(0)).toBeGreaterThan(0);
    expect(deflateUpperBound(1_000_000)).toBeGreaterThan(1_000_000);
  });
});
