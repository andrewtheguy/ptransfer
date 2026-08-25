import { type Event, type Filter, finalizeEvent } from 'nostr-tools';
import {
  D_TAG_FILTER_BATCH,
  EVENT_KIND_FILE_CHUNK,
  NOSTR_FILE_ENCRYPTION_LABEL,
  NOSTR_FILE_EXPIRATION_SEC,
} from './constants';

export interface ChunkEventParams {
  transferId: string;
  index: number;
  total: number;
  /** encoded content from encodeChunkContent */
  content: string;
  /** unix seconds */
  createdAt: number;
}

function chunkDTag(transferId: string, index: number): string {
  return `${transferId}:${index}`;
}

/**
 * Build a signed chunk event. Addressable (NIP-78) with a derived `d` tag so
 * the manifest never needs per-chunk event ids, and explicitly temporary via
 * the NIP-40 expiration tag. Deliberately carries no filename/size/plaintext
 * hash — file metadata travels in the separately encrypted manifest.
 */
export function buildChunkEvent(
  secretKey: Uint8Array,
  params: ChunkEventParams,
): Event {
  const { transferId, index, total, content, createdAt } = params;
  return finalizeEvent(
    {
      kind: EVENT_KIND_FILE_CHUNK,
      content,
      tags: [
        ['d', chunkDTag(transferId, index)],
        ['x', transferId],
        ['chunk', String(index), String(total)],
        ['encryption', NOSTR_FILE_ENCRYPTION_LABEL],
        ['expiration', String(createdAt + NOSTR_FILE_EXPIRATION_SEC)],
      ],
      created_at: createdAt,
    },
    secretKey,
  );
}

/**
 * Build a health-check probe event with the exact production shape (same
 * kind, tag layout, and expiration), namespaced under `probe:` so it can
 * never collide with a real transfer.
 */
export function buildProbeEvent(
  secretKey: Uint8Array,
  content: string,
): { event: Event; dTag: string } {
  const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const dTag = `probe:${randomHex}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const event = finalizeEvent(
    {
      kind: EVENT_KIND_FILE_CHUNK,
      content,
      tags: [
        ['d', dTag],
        ['x', 'probe'],
        ['chunk', '0', '1'],
        ['encryption', NOSTR_FILE_ENCRYPTION_LABEL],
        ['expiration', String(createdAt + NOSTR_FILE_EXPIRATION_SEC)],
      ],
      created_at: createdAt,
    },
    secretKey,
  );
  return { event, dTag };
}

/**
 * Validate an event as a chunk of the given transfer and extract its index.
 * Signature verification is nostr-tools' job on receipt; this checks kind,
 * author, and tag consistency. Index bounds are the caller's job.
 */
export function parseChunkEvent(
  event: Event,
  expectedPubkey: string,
  transferId: string,
): { index: number; content: string } | null {
  if (event.kind !== EVENT_KIND_FILE_CHUNK) return null;
  if (event.pubkey !== expectedPubkey) return null;

  const xTag = event.tags.find((t) => t[0] === 'x')?.[1];
  if (xTag !== transferId) return null;

  const chunkTag = event.tags.find((t) => t[0] === 'chunk');
  if (!chunkTag || chunkTag.length < 3) return null;
  const index = Number(chunkTag[1]);
  if (!Number.isInteger(index) || index < 0) return null;

  const dTag = event.tags.find((t) => t[0] === 'd')?.[1];
  if (dTag !== chunkDTag(transferId, index)) return null;

  if (typeof event.content !== 'string' || event.content.length === 0) {
    return null;
  }

  return { index, content: event.content };
}

/**
 * Filters fetching the given chunk indices by derived `d` tags, batched to
 * D_TAG_FILTER_BATCH identifiers per filter.
 */
export function buildChunkFilters(
  pubkey: string,
  transferId: string,
  indices: number[],
): Filter[] {
  const filters: Filter[] = [];
  for (let i = 0; i < indices.length; i += D_TAG_FILTER_BATCH) {
    const ids = indices
      .slice(i, i + D_TAG_FILTER_BATCH)
      .map((index) => chunkDTag(transferId, index));
    filters.push({
      kinds: [EVENT_KIND_FILE_CHUNK],
      authors: [pubkey],
      '#d': ids,
      limit: ids.length,
    });
  }
  return filters;
}
