import { verifyEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { generateEphemeralKeys } from '../nostr/events';
import {
  EVENT_KIND_FILE_CHUNK,
  NOSTR_FILE_ENCRYPTION_LABEL,
  NOSTR_FILE_EXPIRATION_SEC,
} from './constants';
import {
  buildChunkEvent,
  buildChunkFilters,
  buildProbeEvent,
  parseChunkEvent,
} from './events';

const TRANSFER_ID = 'f'.repeat(32);

describe('chunk events', () => {
  it('builds a signed, expiring, addressable event', () => {
    const { secretKey, publicKey } = generateEphemeralKeys();
    const createdAt = 1_700_000_000;
    const event = buildChunkEvent(secretKey, {
      transferId: TRANSFER_ID,
      index: 5,
      total: 10,
      content: 'abc',
      createdAt,
    });
    expect(event.kind).toBe(EVENT_KIND_FILE_CHUNK);
    expect(event.pubkey).toBe(publicKey);
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toContainEqual(['d', `${TRANSFER_ID}:5`]);
    expect(event.tags).toContainEqual(['x', TRANSFER_ID]);
    expect(event.tags).toContainEqual(['chunk', '5', '10']);
    expect(event.tags).toContainEqual([
      'encryption',
      NOSTR_FILE_ENCRYPTION_LABEL,
    ]);
    expect(event.tags).toContainEqual([
      'expiration',
      String(createdAt + NOSTR_FILE_EXPIRATION_SEC),
    ]);
  });

  it('parses its own events', () => {
    const { secretKey, publicKey } = generateEphemeralKeys();
    const event = buildChunkEvent(secretKey, {
      transferId: TRANSFER_ID,
      index: 0,
      total: 2,
      content: 'payload',
      createdAt: 1_700_000_000,
    });
    expect(parseChunkEvent(event, publicKey, TRANSFER_ID)).toEqual({
      index: 0,
      content: 'payload',
    });
  });

  it('rejects wrong pubkey, transferId, kind, and inconsistent d tag', () => {
    const { secretKey, publicKey } = generateEphemeralKeys();
    const other = generateEphemeralKeys();
    const event = buildChunkEvent(secretKey, {
      transferId: TRANSFER_ID,
      index: 1,
      total: 2,
      content: 'payload',
      createdAt: 1_700_000_000,
    });
    expect(parseChunkEvent(event, other.publicKey, TRANSFER_ID)).toBeNull();
    expect(parseChunkEvent(event, publicKey, 'e'.repeat(32))).toBeNull();
    expect(
      parseChunkEvent({ ...event, kind: 1 }, publicKey, TRANSFER_ID),
    ).toBeNull();
    const badD = {
      ...event,
      tags: event.tags.map((t) =>
        t[0] === 'd' ? ['d', `${TRANSFER_ID}:2`] : t,
      ),
    };
    expect(parseChunkEvent(badD, publicKey, TRANSFER_ID)).toBeNull();
  });

  it('probe events use the production shape under the probe namespace', () => {
    const { secretKey } = generateEphemeralKeys();
    const { event, dTag } = buildProbeEvent(secretKey, 'probe-content');
    expect(event.kind).toBe(EVENT_KIND_FILE_CHUNK);
    expect(dTag).toMatch(/^probe:[0-9a-f]{16}$/);
    expect(event.tags).toContainEqual(['d', dTag]);
    expect(event.tags.some((t) => t[0] === 'expiration')).toBe(true);
    expect(verifyEvent(event)).toBe(true);
  });
});

describe('buildChunkFilters', () => {
  it('batches d identifiers at 100 per filter', () => {
    const indices = Array.from({ length: 101 }, (_, i) => i);
    const filters = buildChunkFilters('pk', TRANSFER_ID, indices);
    expect(filters.length).toBe(2);
    expect(filters[0]['#d']?.length).toBe(100);
    expect(filters[1]['#d']).toEqual([`${TRANSFER_ID}:100`]);
    expect(filters[0].authors).toEqual(['pk']);
    expect(filters[0].kinds).toEqual([EVENT_KIND_FILE_CHUNK]);
  });
});
