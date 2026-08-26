import { describe, expect, it } from 'vitest';
import spec from '../../docs/INTEROP_PROTOCOL.md?raw';
import { INTEROP_PROTOCOL_VERSION } from './protocol';

describe('interop protocol version', () => {
  it('is a bare monotonic integer', () => {
    expect(INTEROP_PROTOCOL_VERSION).toMatch(/^[1-9][0-9]*$/);
  });

  // The spec document is what another implementation reads; the constant is
  // what its build pins. A bump that lands in only one of the two is the
  // failure this guards against.
  it('matches the version declared by docs/INTEROP_PROTOCOL.md', () => {
    const declared = spec.match(
      /^\*\*Interop protocol version: `([^`]+)`\*\*$/m,
    );

    expect(declared, 'spec is missing its version declaration line').not.toBe(
      null,
    );
    expect(declared?.[1]).toBe(INTEROP_PROTOCOL_VERSION);
  });

  // The spec publishes the transcript digests as test vectors so another
  // implementation can check its canonicalization without running a transfer.
  // They are only useful while they still match the ones transcript.test.ts
  // pins, so fail here if the doc drifts.
  it('publishes the frozen transcript vectors', () => {
    expect(spec).toContain(
      'edf3c4ce9b70adf0cb6e316e247f2f840e18af094d20466dfd55c00e694be675',
    );
    expect(spec).toContain(
      'd71c5d4c12479dfb7e1e4f7c9fd169cddd73206e8c369d49a98f7b726a025f84',
    );
  });
});
