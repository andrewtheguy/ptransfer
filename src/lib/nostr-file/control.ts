import { deflateSync, inflateSync } from 'fflate';
import { type Event, finalizeEvent } from 'nostr-tools';
import { decrypt, encrypt } from '../crypto/aes-gcm';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../nostr/events';
import { normalizeRelayUrl } from '../nostr/relays';
import {
  CONTROL_DEMOTE_FAILURE_RATIO,
  CONTROL_DEMOTE_MIN_PUBLISHES,
  CONTROL_KEY_INFO,
  CONTROL_MESSAGE_MAX_BYTES,
  CONTROL_RELAY_MAX,
  EVENT_KIND_FILE_CHUNK,
  NOSTR_FILE_AAD_PREFIX,
  PUBLISH_BACKOFF_BASE_MS,
  PUBLISH_MAX_RETRIES,
  UPLOAD_RELAY_COUNT,
} from './constants';
import { isValidNostrFileManifest, type NostrFileManifest } from './manifest';
import type { NostrFilePool, PoolSubscription } from './pool';
import { type NostrFileTransferStats, relayStatsFor } from './stats';

/**
 * Encrypted control channel for the live (single-copy) relay transfer.
 *
 * Both peers derive the same AES-GCM key from the session file key (HKDF,
 * distinct info label), which itself comes from the Code Exchange ECDH
 * secret, so only the two peers of that exchange can read or forge control
 * messages. Messages ride on the control relays — the proven relays the
 * offer named, probed with a control-sized event (the chunk ring is
 * announced over this channel instead) — as addressable events of the chunk
 * kind with a unique `d` tag per message and the usual NIP-40 expiration, so
 * a peer that subscribes late — or whose socket dropped — gets the stored
 * backlog via the `since` filter.
 *
 * The AAD binds every message to the transfer and to the sending role, so a
 * receiver message can never be replayed as a sender message. Replay within
 * a role is handled by the per-message counter `n` that each side checks.
 */

export type ControlRole = 'sender' | 'receiver';

/**
 * Placement of one chunk: ring position of the relay holding it and the
 * re-send generation (0 = first placement). A receiver retries a chunk it
 * could not fetch when either value changes — or from the same placement
 * after LIVE_FETCH_RETRY_MS, so a transient fetch failure heals on its own.
 */
export type ChunkPlacement = [index: number, pos: number, gen: number];

/**
 * Sender → receiver: chunks [0, upto) are uploaded. `relays` is the data
 * ring in placement order — empty while the sender is still discovering
 * storage relays, which only signals presence. `map` holds one character per
 * chunk — the position in THIS message's `relays` of the relay it is on,
 * encoded with POSITION_ALPHABET — and `gens` lists the chunks that were
 * re-sent with their current generation (everything else is generation 0).
 * `ctl` is the sender's current control set: the offer's signaling relays
 * minus the ones it has demoted, plus the replacements it promoted in their
 * place. The receiver adds what it does not already hold, which is how a
 * relay the offer never named reaches it — over the signaling relays that
 * still work.
 *
 * The whole ring, placement, and control set travel in every announcement,
 * so a lost one costs nothing: a swap the receiver missed is repeated on the
 * next heartbeat rather than needing an acknowledgement of its own. Control
 * bodies are deflated before sealing, which squeezes the near-periodic map
 * and shared-prefix relay URLs to a few hundred bytes.
 */
export interface AvailMessage {
  t: 'avail';
  n: number;
  upto: number;
  relays: string[];
  map: string;
  gens: [index: number, gen: number][];
  ctl: string[];
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

/**
 * Sender → receiver, first: what is being relayed. Sent when the fallback
 * starts, once the file is hashed and chunked; everything the receiver needs
 * to fetch and verify chunks that a code used to carry.
 */
export interface ManifestMessage {
  t: 'manifest';
  n: number;
  manifest: NostrFileManifest;
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

export type SenderMessage = ManifestMessage | AvailMessage | CancelMessage;
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

/**
 * A relay list a peer sent: canonical `wss://` URLs, at most `max` of them,
 * no duplicates. Null when it is not one.
 *
 * Positions index into the ring list, and both lists decide which sockets
 * this side opens, so a repeat under an equivalent URL form (a trailing
 * slash, an explicit `:443`) is forged or corrupt rather than merely untidy.
 */
function parseRelayList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const relays: string[] = [];
  for (const relay of value) {
    if (typeof relay !== 'string' || relay.length >= 200) return null;
    const normalized = normalizeRelayUrl(relay);
    if (normalized === null) return null;
    relays.push(normalized);
  }
  if (new Set(relays).size !== relays.length) return null;
  return relays;
}

/**
 * Shape-check a decrypted sender message; null if it is not one. Avail
 * messages are self-describing: `map` positions are validated against the
 * `relays` list travelling in the same message. `totalChunks` is null until
 * the manifest has arrived, and an avail before it is rejected.
 */
export function parseSenderMessage(
  value: unknown,
  totalChunks: number | null,
): SenderMessage | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (!isCount(m.n, Number.MAX_SAFE_INTEGER)) return null;
  if (m.t === 'cancel') return { t: 'cancel', n: m.n };
  if (m.t === 'manifest') {
    if (!isValidNostrFileManifest(m.manifest)) return null;
    return { t: 'manifest', n: m.n, manifest: m.manifest };
  }
  if (m.t === 'avail') {
    if (totalChunks === null) return null;
    const relays = parseRelayList(m.relays, UPLOAD_RELAY_COUNT);
    if (relays === null) return null;
    // A control set is never empty: the sender publishes this very message
    // over it, and demotion stops at MIN_CONTROL_RELAYS.
    const ctl = parseRelayList(m.ctl, CONTROL_RELAY_MAX);
    if (ctl === null || ctl.length === 0) return null;
    if (!isCount(m.upto, totalChunks)) return null;
    // No ring yet (still discovering) is presence-only: nothing placed.
    if (relays.length === 0 && m.upto > 0) return null;
    if (typeof m.map !== 'string' || m.map.length !== m.upto) return null;
    for (const char of m.map) {
      const pos = decodePosition(char);
      if (pos < 0 || pos >= relays.length) return null;
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
      relays,
      map: m.map,
      gens: m.gens as [number, number][],
      ctl,
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
  /** Relays messages are currently published to, demotions excluded. */
  relays(): string[];
  /**
   * Start publishing to — and subscribing to — these relays as well, up to
   * CONTROL_RELAY_MAX in total. Already-known and unusable URLs are ignored;
   * returns what was actually taken on.
   */
  add(relays: string[]): string[];
  close(): void;
}

/**
 * When a control relay stops being worth publishing to. `onDemoted` is
 * called once per relay, from inside the failing publish, so the caller can
 * put a replacement in its place; the channel itself never promotes.
 *
 * Omit it and nothing is ever demoted — which is what the anonymous
 * fallback's two-relay onion pool wants, having nothing to fall back to.
 */
export interface ControlDemotionPolicy {
  /** Never demote below this many active relays. */
  minRelays: number;
  onDemoted: (relay: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHANNEL_CLOSED_MESSAGE = 'Control channel closed';
const DELIVERY_FAILED_MESSAGE =
  'Lost contact with the Nostr relays — the control message could not be delivered';

/**
 * The channel's live relay set.
 *
 * Publishing shrinks it: a relay that gives up more than
 * CONTROL_DEMOTE_FAILURE_RATIO of its settled publishes, once at least
 * CONTROL_DEMOTE_MIN_PUBLISHES of them have settled, stops being published
 * to. `add` grows it, with the replacement the caller chose.
 *
 * A demotion leaves the subscription in place, and the subscription set only
 * ever grows. That is what keeps a swap safe without an acknowledgement:
 * whatever the two sides currently publish to, each still hears everything
 * the other says on every relay it has ever known, so the peer can never be
 * stranded on a relay this side stopped watching.
 */
class ControlRelaySet {
  /** Published to, in the order they were taken on. */
  private active: string[];
  /** Everything ever taken on — subscribed to, demoted or not. */
  private readonly known: Set<string>;
  private readonly settled = new Map<string, { ok: number; gaveUp: number }>();
  private readonly stats: NostrFileTransferStats | undefined;
  private readonly policy: ControlDemotionPolicy | undefined;

  constructor(
    relays: string[],
    stats: NostrFileTransferStats | undefined,
    policy: ControlDemotionPolicy | undefined,
  ) {
    // Taken as given, deliberately: `accept` runs `normalizeRelayUrl` because
    // it takes URLs off a peer's `avail`, and that normalizer refuses `ws://`
    // and `.onion` by design. The anonymous fallback opens this channel on the
    // onion pool, so canonicalizing here would empty its relay set. Callers
    // hand over canonical URLs already — a pool from `canonicalRelayPool`, an
    // offer list through `normalizeOfferRelays`, a probe result from
    // `canonicalUrls`.
    this.active = [...new Set(relays)];
    this.known = new Set(this.active);
    this.stats = stats;
    this.policy = policy;
  }

  /** A snapshot: one publish walks the set it started with. */
  snapshot(): string[] {
    return [...this.active];
  }

  /** Relays not yet known, capped at what the channel may ever hold. */
  accept(relays: string[]): string[] {
    const room = CONTROL_RELAY_MAX - this.known.size;
    if (room <= 0) return [];
    const fresh: string[] = [];
    for (const relay of relays) {
      if (fresh.length >= room) break;
      const url = normalizeRelayUrl(relay);
      if (url === null || this.known.has(url)) continue;
      this.known.add(url);
      this.active.push(url);
      fresh.push(url);
      if (this.stats) relayStatsFor(this.stats, url, 'control');
    }
    return fresh;
  }

  private tally(relay: string): { ok: number; gaveUp: number } {
    let entry = this.settled.get(relay);
    if (!entry) {
      entry = { ok: 0, gaveUp: 0 };
      this.settled.set(relay, entry);
    }
    return entry;
  }

  accepted(relay: string, bytes: number): void {
    this.tally(relay).ok++;
    if (!this.stats) return;
    const row = relayStatsFor(this.stats, relay, 'control');
    row.eventsAccepted++;
    row.bytesUp += bytes;
  }

  attempted(relay: string): void {
    if (this.stats)
      relayStatsFor(this.stats, relay, 'control').publishAttempts++;
  }

  /** Every retry rejected. Demotes the relay once the ratio condemns it. */
  gaveUp(relay: string): void {
    const tally = this.tally(relay);
    tally.gaveUp++;
    if (this.stats) {
      relayStatsFor(this.stats, relay, 'control').publishesFailed++;
    }
    if (!this.policy) return;
    if (this.active.length <= this.policy.minRelays) return;
    const settled = tally.ok + tally.gaveUp;
    if (settled < CONTROL_DEMOTE_MIN_PUBLISHES) return;
    if (tally.gaveUp / settled < CONTROL_DEMOTE_FAILURE_RATIO) return;
    const at = this.active.indexOf(relay);
    if (at < 0) return;
    this.active.splice(at, 1);
    if (this.stats) {
      relayStatsFor(this.stats, relay, 'control').demoted = true;
      this.stats.controlRelaysDemoted++;
    }
    this.policy.onDemoted(relay);
  }
}

/**
 * Publish to every relay; resolve on the first acceptance, keep retrying the
 * rest in the background, reject only when all relays gave up. Per-relay
 * attempts, acceptances, bytes, and give-ups are tallied into `stats`, and a
 * give-up may demote the relay it happened on.
 */
function publishToAny(
  pool: NostrFilePool,
  set: ControlRelaySet,
  event: Event,
  isClosed: () => boolean,
): Promise<void> {
  // A channel closed before the first attempt says so, rather than blaming
  // relays it never tried; an empty ring has to settle too, or the caller
  // waits forever on a loop that never runs.
  if (isClosed()) return Promise.reject(new Error(CHANNEL_CLOSED_MESSAGE));
  const relays = set.snapshot();
  if (relays.length === 0) {
    return Promise.reject(new Error(DELIVERY_FAILED_MESSAGE));
  }
  return new Promise<void>((resolve, reject) => {
    let failures = 0;
    for (const relay of relays) {
      void (async () => {
        for (let attempt = 0; attempt <= PUBLISH_MAX_RETRIES; attempt++) {
          if (isClosed()) break;
          set.attempted(relay);
          try {
            await Promise.all(pool.publish([relay], event));
            set.accepted(relay, event.content.length);
            resolve();
            return;
          } catch {
            if (attempt < PUBLISH_MAX_RETRIES) {
              await sleep(PUBLISH_BACKOFF_BASE_MS * 2 ** attempt);
            }
          }
        }
        if (!isClosed()) set.gaveUp(relay);
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
 * Open the control channel: subscribe to the peer's messages on every
 * control relay (backlog since the transfer started, live thereafter) and
 * return a sender for our own.
 *
 * The relay set is live rather than fixed. With a `demotion` policy, a relay
 * that keeps giving up publishes stops being published to and the caller is
 * told, so it can `add` a replacement; the subscription stays, so nothing the
 * peer sends over it is lost. Without one — the anonymous fallback's onion
 * pool, the hello watch — the set only ever grows.
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
    /** When to stop publishing to a relay. Omitted: never. */
    demotion?: ControlDemotionPolicy;
    onMessage: (message: unknown, pubkey: string) => void;
  },
): ControlChannel {
  const { transferId, key, role, secretKey, onMessage } = opts;
  const peerRole: ControlRole = role === 'sender' ? 'receiver' : 'sender';
  const seen = new Set<string>();
  let closed = false;
  let n = 0;

  const set = new ControlRelaySet(relays, opts.stats, opts.demotion);

  const filter = {
    kinds: [EVENT_KIND_FILE_CHUNK],
    '#x': [controlChannelTag(transferId)],
    since: opts.since,
    ...(opts.authors ? { authors: opts.authors } : {}),
  };
  const onevent = (event: Event) => {
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
  };

  // One subscription per batch of relays taken on. A promotion opens another
  // rather than reopening the first: the events already read are in `seen`,
  // and the relays already connected have no reason to re-serve their
  // backlog because a new one joined.
  const subscriptions: PoolSubscription[] = [
    pool.subscribeMany(set.snapshot(), filter, { onevent }),
  ];

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
      await publishToAny(pool, set, event, () => closed);
      if (opts.stats) opts.stats.controlSent++;
    },
    relays() {
      return set.snapshot();
    },
    add(more) {
      if (closed) return [];
      const fresh = set.accept(more);
      if (fresh.length > 0) {
        subscriptions.push(pool.subscribeMany(fresh, filter, { onevent }));
      }
      return fresh;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const subscription of subscriptions) subscription.close();
    },
  };
}
