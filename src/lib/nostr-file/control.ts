import { deflateSync, inflateSync } from 'fflate';
import { type Event, finalizeEvent } from 'nostr-tools';
import { decrypt, encrypt } from '../crypto/aes-gcm';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../nostr/events';
import {
  CONTROL_KEY_INFO,
  CONTROL_MESSAGE_MAX_BYTES,
  EVENT_KIND_FILE_CHUNK,
  NOSTR_FILE_AAD_PREFIX,
  PUBLISH_BACKOFF_BASE_MS,
  PUBLISH_MAX_RETRIES,
} from './constants';
import type { NostrFilePool, PoolSubscription } from './pool';
import type { NostrFileTransferStats } from './stats';

/**
 * Encrypted control channel for the live (single-copy) relay variant.
 *
 * Both peers derive the same AES-GCM key from the file key that travels in
 * the manual payload (HKDF, distinct info label), so only the holder of the
 * code can read or forge control messages. Messages ride on the same relay
 * ring as the chunks, as addressable events of the chunk kind (the kind the
 * health probe validated) with a unique `d` tag per message and the usual
 * NIP-40 expiration, so a peer that subscribes late — or whose socket
 * dropped — gets the stored backlog via the `since` filter.
 *
 * The AAD binds every message to the transfer and to the sending role, so a
 * receiver message can never be replayed as a sender message. Replay within
 * a role is handled by the per-message counter `n` that each side checks.
 */

export type ControlRole = 'sender' | 'receiver';

/**
 * Placement of one chunk: ring position of the relay holding it and the
 * re-send generation (0 = first placement). A receiver retries a chunk it
 * could not fetch only when either value changes.
 */
export type ChunkPlacement = [index: number, pos: number, gen: number];

/**
 * Sender → receiver: chunks [0, upto) are uploaded. `map` holds one
 * character per chunk — the ring position of the relay it is on, encoded
 * with POSITION_ALPHABET — and `gens` lists the chunks that were re-sent
 * with their current generation (everything else is generation 0). The
 * whole placement travels in every announcement, so a lost one costs
 * nothing; control bodies are deflated before sealing, which squeezes the
 * near-periodic map to a few hundred bytes.
 */
export interface AvailMessage {
  t: 'avail';
  n: number;
  upto: number;
  map: string;
  gens: [index: number, gen: number][];
}

/** One character per ring position; bounds the ring at 64 relays. */
export const POSITION_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodePosition(pos: number): string {
  if (pos < 0 || pos >= POSITION_ALPHABET.length) {
    throw new Error(`Ring position out of range: ${pos}`);
  }
  return POSITION_ALPHABET[pos];
}

/** Ring position for a map character, or -1 if it is not one. */
export function decodePosition(char: string): number {
  return POSITION_ALPHABET.indexOf(char);
}

export interface HelloMessage {
  t: 'hello';
  n: number;
}

/** Receiver → sender: outcome of fetching what an `avail` announced. */
export interface AckMessage {
  t: 'ack';
  n: number;
  /** `n` of the avail message this answers. */
  avail: number;
  /** Chunks the receiver holds. */
  have: number;
  /** Chunks tried at the given placement and not found / not decryptable. */
  missing: ChunkPlacement[];
}

export interface DoneMessage {
  t: 'done';
  n: number;
}

export interface CancelMessage {
  t: 'cancel';
  n: number;
}

export type SenderMessage = AvailMessage | CancelMessage;
export type ReceiverMessage =
  | HelloMessage
  | AckMessage
  | DoneMessage
  | CancelMessage;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Derive the control-channel key from the raw file key. Non-extractable;
 * the caller keeps ownership of (and wipes) `keyBytes`.
 */
export async function deriveControlKey(
  keyBytes: Uint8Array,
  transferId: string,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8(transferId) as BufferSource,
      info: utf8(CONTROL_KEY_INFO) as BufferSource,
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function controlChannelTag(transferId: string): string {
  return `${transferId}:ctl`;
}

function controlAad(transferId: string, role: ControlRole): Uint8Array {
  return utf8(`${NOSTR_FILE_AAD_PREFIX}:ctl:${transferId}:${role}`);
}

/** JSON → deflate → AES-GCM (role/transfer-bound AAD) → base64. */
export async function encodeControlMessage(
  key: CryptoKey,
  transferId: string,
  role: ControlRole,
  message: object,
): Promise<string> {
  const sealed = await encrypt(
    key,
    deflateSync(utf8(JSON.stringify(message))),
    undefined,
    controlAad(transferId, role),
  );
  return uint8ArrayToBase64(sealed);
}

/**
 * Throws when the content was not sealed under this transfer + role, or
 * inflates past CONTROL_MESSAGE_MAX_BYTES.
 */
export async function decodeControlMessage(
  key: CryptoKey,
  transferId: string,
  role: ControlRole,
  content: string,
): Promise<unknown> {
  const compressed = await decrypt(
    key,
    base64ToUint8Array(content),
    controlAad(transferId, role),
  );
  // Fixed output buffer: an over-sized body comes back at max + 1 (or
  // throws) instead of ballooning memory.
  const plaintext = inflateSync(compressed, {
    out: new Uint8Array(CONTROL_MESSAGE_MAX_BYTES + 1),
  });
  if (plaintext.length > CONTROL_MESSAGE_MAX_BYTES) {
    throw new Error('Control message too large');
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}

export function buildControlEvent(
  secretKey: Uint8Array,
  params: {
    transferId: string;
    role: ControlRole;
    n: number;
    content: string;
    /** unix seconds; the transfer's expiry clock, not "now" */
    expiresAt: number;
  },
): Event {
  const { transferId, role, n, content, expiresAt } = params;
  return finalizeEvent(
    {
      kind: EVENT_KIND_FILE_CHUNK,
      content,
      tags: [
        ['d', `${transferId}:ctl:${role}:${n}`],
        ['x', controlChannelTag(transferId)],
        ['expiration', String(expiresAt)],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey,
  );
}

function isCount(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

function isPlacementList(
  value: unknown,
  totalChunks: number,
  relayCount: number,
): value is ChunkPlacement[] {
  if (!Array.isArray(value) || value.length > totalChunks) return false;
  return value.every(
    (p) =>
      Array.isArray(p) &&
      p.length === 3 &&
      isCount(p[0], totalChunks - 1) &&
      isCount(p[1], relayCount - 1) &&
      isCount(p[2], Number.MAX_SAFE_INTEGER),
  );
}

/** Shape-check a decrypted sender message; null if it is not one. */
export function parseSenderMessage(
  value: unknown,
  totalChunks: number,
  relayCount: number,
): SenderMessage | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (!isCount(m.n, Number.MAX_SAFE_INTEGER)) return null;
  if (m.t === 'cancel') return { t: 'cancel', n: m.n };
  if (m.t === 'avail') {
    if (!isCount(m.upto, totalChunks)) return null;
    if (typeof m.map !== 'string' || m.map.length !== m.upto) return null;
    for (const char of m.map) {
      const pos = decodePosition(char);
      if (pos < 0 || pos >= relayCount) return null;
    }
    if (!Array.isArray(m.gens) || m.gens.length > m.upto) return null;
    const upto = m.upto;
    const gensOk = m.gens.every(
      (g) =>
        Array.isArray(g) &&
        g.length === 2 &&
        isCount(g[0], upto - 1) &&
        isCount(g[1], Number.MAX_SAFE_INTEGER) &&
        g[1] >= 1,
    );
    if (!gensOk) return null;
    return {
      t: 'avail',
      n: m.n,
      upto,
      map: m.map,
      gens: m.gens as [number, number][],
    };
  }
  return null;
}

/** Shape-check a decrypted receiver message; null if it is not one. */
export function parseReceiverMessage(
  value: unknown,
  totalChunks: number,
  relayCount: number,
): ReceiverMessage | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (!isCount(m.n, Number.MAX_SAFE_INTEGER)) return null;
  if (m.t === 'hello' || m.t === 'done' || m.t === 'cancel') {
    return { t: m.t, n: m.n };
  }
  if (m.t === 'ack') {
    if (!isCount(m.avail, Number.MAX_SAFE_INTEGER)) return null;
    if (!isCount(m.have, totalChunks)) return null;
    if (!isPlacementList(m.missing, totalChunks, relayCount)) return null;
    return {
      t: 'ack',
      n: m.n,
      avail: m.avail,
      have: m.have,
      missing: m.missing,
    };
  }
  return null;
}

export interface ControlChannel {
  /**
   * Seal, sign, and publish a message (the channel stamps `n`). Resolves as
   * soon as one relay accepts it; rejects when every relay refused.
   */
  send(message: object): Promise<void>;
  close(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHANNEL_CLOSED_MESSAGE = 'Control channel closed';
const DELIVERY_FAILED_MESSAGE =
  'Lost contact with the Nostr relays — the control message could not be delivered';

/**
 * Publish to every relay; resolve on the first acceptance, keep retrying the
 * rest in the background, reject only when all relays gave up.
 */
function publishToAny(
  pool: NostrFilePool,
  relays: string[],
  event: Event,
  isClosed: () => boolean,
): Promise<void> {
  // A channel closed before the first attempt says so, rather than blaming
  // relays it never tried; an empty ring has to settle too, or the caller
  // waits forever on a loop that never runs.
  if (isClosed()) return Promise.reject(new Error(CHANNEL_CLOSED_MESSAGE));
  if (relays.length === 0) {
    return Promise.reject(new Error(DELIVERY_FAILED_MESSAGE));
  }
  return new Promise<void>((resolve, reject) => {
    let failures = 0;
    for (const relay of relays) {
      void (async () => {
        for (let attempt = 0; attempt <= PUBLISH_MAX_RETRIES; attempt++) {
          if (isClosed()) break;
          try {
            await Promise.all(pool.publish([relay], event));
            resolve();
            return;
          } catch {
            if (attempt < PUBLISH_MAX_RETRIES) {
              await sleep(PUBLISH_BACKOFF_BASE_MS * 2 ** attempt);
            }
          }
        }
        failures++;
        if (failures === relays.length) {
          reject(
            new Error(
              isClosed() ? CHANNEL_CLOSED_MESSAGE : DELIVERY_FAILED_MESSAGE,
            ),
          );
        }
      })();
    }
  });
}

/**
 * Open the control channel: subscribe to the peer's messages on every ring
 * relay (backlog since the transfer started, live thereafter) and return a
 * sender for our own.
 *
 * `onMessage` receives every decryptable peer message with its author
 * pubkey; authorization (which pubkey is the peer) and ordering are the
 * caller's job. Undecryptable or malformed events are dropped silently.
 */
export function openControlChannel(
  pool: NostrFilePool,
  relays: string[],
  opts: {
    transferId: string;
    key: CryptoKey;
    role: ControlRole;
    secretKey: Uint8Array;
    /** unix seconds: subscription lower bound */
    since: number;
    /** unix seconds: expiration stamped on our events */
    expiresAt: number;
    /** Restrict the subscription to these authors (receiver knows the sender). */
    authors?: string[];
    /** Tally sent events and unsealed peer messages into these totals. */
    stats?: NostrFileTransferStats;
    onMessage: (message: unknown, pubkey: string) => void;
  },
): ControlChannel {
  const { transferId, key, role, secretKey, onMessage } = opts;
  const peerRole: ControlRole = role === 'sender' ? 'receiver' : 'sender';
  const seen = new Set<string>();
  let closed = false;
  let n = 0;

  const subscription: PoolSubscription = pool.subscribeMany(
    relays,
    {
      kinds: [EVENT_KIND_FILE_CHUNK],
      '#x': [controlChannelTag(transferId)],
      since: opts.since,
      ...(opts.authors ? { authors: opts.authors } : {}),
    },
    {
      onevent: (event) => {
        if (closed || seen.has(event.id)) return;
        seen.add(event.id);
        const dTag = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
        if (!dTag.startsWith(`${transferId}:ctl:${peerRole}:`)) return;
        void decodeControlMessage(key, transferId, peerRole, event.content)
          .then((message) => {
            if (closed) return;
            if (opts.stats) opts.stats.controlReceived++;
            onMessage(message, event.pubkey);
          })
          .catch(() => {
            // Not sealed under this transfer's key — ignore.
          });
      },
    },
  );

  return {
    async send(message) {
      if (closed) throw new Error(CHANNEL_CLOSED_MESSAGE);
      n++;
      const content = await encodeControlMessage(key, transferId, role, {
        ...message,
        n,
      });
      const event = buildControlEvent(secretKey, {
        transferId,
        role,
        n,
        content,
        expiresAt: opts.expiresAt,
      });
      await publishToAny(pool, relays, event, () => closed);
      if (opts.stats) opts.stats.controlSent++;
    },
    close() {
      if (closed) return;
      closed = true;
      subscription.close();
    },
  };
}
