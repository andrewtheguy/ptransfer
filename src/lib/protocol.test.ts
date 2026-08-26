import { describe, expect, it } from 'vitest';
import spec from '../../docs/INTEROP_PROTOCOL.md?raw';
import {
  computeRendezvousTranscriptHash,
  computeTransferMetadataHash,
} from './nostr/transcript';
import {
  METADATA_VECTOR,
  RENDEZVOUS_VECTOR,
  VECTOR_SALT,
} from './nostr/transcript-vectors';
import { INTEROP_PROTOCOL_VERSION } from './protocol';

/** The `## 9. Test vectors` section, split into its `### 9.x` subsections. */
function vectorSubsections(): string[] {
  const start = spec.indexOf('## 9. Test vectors');
  const end = spec.indexOf('## 10.');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('spec is missing its test-vector section');
  }
  // [0] is the section preamble; the rest are the ### subsections in order.
  return spec.slice(start, end).split(/^### /m).slice(1);
}

function documentedInput(section: string): unknown {
  const block = section.match(/```json\n([\s\S]*?)\n```/);
  if (!block) throw new Error(`no input block in: ${section.slice(0, 40)}`);
  return JSON.parse(block[1]);
}

function documentedDigest(section: string): string {
  const block = section.match(/```\n([0-9a-f]{64})\n```/);
  if (!block) throw new Error(`no digest block in: ${section.slice(0, 40)}`);
  return block[1];
}

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
});

// Another implementation checks its canonicalization against the vectors the
// spec publishes, so a documented input that does not actually produce its
// documented digest is worse than publishing nothing: it sends someone hunting
// a bug in working code. Recompute both from the spec's own inputs with the
// production helpers rather than searching the text for digests, which would
// pass just as happily with a mangled input or the two digests swapped.
describe('published transcript vectors', () => {
  const [rendezvous, metadata] = vectorSubsections();

  it('publishes exactly the inputs the frozen vectors pin', () => {
    expect(documentedInput(rendezvous)).toEqual(RENDEZVOUS_VECTOR.payload);
    expect(documentedInput(metadata)).toEqual(METADATA_VECTOR.metadata);

    // The salt is prose, not JSON, so derive the sentence from the fixture
    // instead of restating it.
    const byte = VECTOR_SALT[0];
    expect(VECTOR_SALT.every((b) => b === byte)).toBe(true);
    expect(rendezvous).toContain(
      `${VECTOR_SALT.length} bytes of \`0x${byte.toString(16).padStart(2, '0')}\``,
    );
  });

  it('publishes digests the production canonicalization reproduces', async () => {
    expect(documentedDigest(rendezvous)).toBe(
      await computeRendezvousTranscriptHash(
        RENDEZVOUS_VECTOR.payload,
        VECTOR_SALT,
      ),
    );
    expect(documentedDigest(metadata)).toBe(
      await computeTransferMetadataHash(METADATA_VECTOR.metadata),
    );
  });

  it('keeps each digest with the transcript it belongs to', () => {
    expect(rendezvous).not.toContain(METADATA_VECTOR.digest);
    expect(metadata).not.toContain(RENDEZVOUS_VECTOR.digest);
  });
});
