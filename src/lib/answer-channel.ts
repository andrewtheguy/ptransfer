import { type Event, finalizeEvent } from 'nostr-tools';
import { decrypt, encrypt } from './crypto/aes-gcm';
import { generateEphemeralKeys, uint8ArrayToBase64 } from './nostr/events';
import { normalizeRelayUrl } from './nostr/relays';
import {
  CONTROL_RELAY_COUNT,
  EVENT_KIND_FILE_CHUNK,
  MIN_CONTROL_RELAYS,
  PUBLISH_BACKOFF_BASE_MS,
  PUBLISH_MAX_RETRIES,
} from './nostr-file/constants';
import type { NostrFilePool, PoolSubscription } from './nostr-file/pool';

/**
 * Nostr answer-return channel for Manual Exchange.
 *
 * Only the sender's offer is carried by hand. The offer names a small set of
 * proven relays and carries a random secret; the receiver seals its answer
 * under a key derived from that secret and publishes it to those relays, so
 * the second hand-carried hop disappears. This channel carries signaling
 * only; if the direct WebRTC connection later fails, Manual Exchange can use
 * the separate Nostr file-relay fallback.
 *
 * Relays see a temporary opaque blob on a derived tag: the channel key and
 * the channel tag both come from the offer's secret via HKDF, so a relay
 * cannot link the tag back to the secret, and only a holder of the offer can
 * read or forge an answer. That is the same trust position the offer already
 * had — whoever holds the offer can answer it — see the security note in
 * docs/ARCHITECTURE.md.
 *
 * The probe bar, relay count, and floor are deliberately the file relay's
 * control-channel values: an answer is a small message with the same
 * write->read requirement as a control message.
 */

/** Relays named in the offer, at most. */
export const ANSWER_RELAY_COUNT = CONTROL_RELAY_COUNT;
/** Fewer usable relays than this and the offer goes out manual-only. */
export const MIN_ANSWER_RELAYS = MIN_CONTROL_RELAYS;
/** Bytes of the offer-borne channel secret. */
export const ANSWER_SECRET_BYTES = 32;
/** Ceiling on a sealed answer, before and after opening it. */
export const ANSWER_MAX_BYTES = 16 * 1024;
/**
 * How long the receiver spends getting its answer onto the relays. It
 * publishes to all of them and stops early once ANSWER_PUBLISH_TARGET have
 * accepted; this bounds the wait when the rest are slow or hung.
 */
export const ANSWER_PUBLISH_TIMEOUT_MS = 10_000;
/** Acceptances that make the answer safely reachable; the rest are extra. */
export const ANSWER_PUBLISH_TARGET = MIN_ANSWER_RELAYS;

const CHANNEL_LABEL = 'ptransfer-manual-answer:v1';
const TAG_INFO = `${CHANNEL_LABEL}:tag`;
const KEY_INFO = `${CHANNEL_LABEL}:key`;
/** Base64 of exactly ANSWER_SECRET_BYTES bytes. */
const SECRET_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The offer's answer-channel secret; travels only in the manual payload. */
export function generateAnswerSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ANSWER_SECRET_BYTES));
}

export function encodeAnswerSecret(secret: Uint8Array): string {
  return uint8ArrayToBase64(secret);
}

/** Decode an offer's secret; null when it is not one. */
export function decodeAnswerSecret(value: string): Uint8Array | null {
  if (!SECRET_BASE64.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.length === ANSWER_SECRET_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

export interface AnswerChannel {
  /** Public per-transfer identifier the answer event is filed under. */
  tag: string;
  /** AES-256-GCM key sealing the answer. */
  key: CryptoKey;
}

/**
 * Derive the channel tag and key from the offer's secret. Distinct HKDF info
 * labels keep the published tag from leaking anything about the key.
 */
export async function deriveAnswerChannel(
  secret: Uint8Array,
): Promise<AnswerChannel> {
  const base = await crypto.subtle.importKey(
    'raw',
    secret as BufferSource,
    'HKDF',
    false,
    ['deriveKey', 'deriveBits'],
  );
  const hkdf = (info: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: utf8(CHANNEL_LABEL) as BufferSource,
    info: utf8(info) as BufferSource,
  });
  const tagBits = await crypto.subtle.deriveBits(hkdf(TAG_INFO), base, 128);
  const tag = Array.from(new Uint8Array(tagBits), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const key = await crypto.subtle.deriveKey(
    hkdf(KEY_INFO),
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { tag, key };
}

function answerAad(tag: string): Uint8Array {
  return utf8(`${CHANNEL_LABEL}:${tag}`);
}

function answerDTag(tag: string): string {
  return `${tag}:answer`;
}

/** Offer-side validation of the relay list the receiver is asked to use. */
export function normalizeAnswerRelays(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > ANSWER_RELAY_COUNT) return null;
  const relays: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length >= 200) return null;
    const normalized = normalizeRelayUrl(entry);
    if (normalized === null || relays.includes(normalized)) return null;
    relays.push(normalized);
  }
  return relays.length >= MIN_ANSWER_RELAYS ? relays : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Seal the answer under the channel key and publish it to every relay,
 * resolving as soon as one accepts it and rejecting only when all of them
 * refused. The event carries the transfer's own expiration, so relays drop it
 * when the manual exchange would have expired anyway.
 */
export async function publishAnswer(
  pool: NostrFilePool,
  relays: string[],
  opts: {
    channel: AnswerChannel;
    /** The PT01 answer blob, exactly as the manual path would hand it over. */
    answer: Uint8Array;
    /** unix seconds */
    expiresAt: number;
  },
): Promise<void> {
  const { channel, answer, expiresAt } = opts;
  if (answer.length > ANSWER_MAX_BYTES) {
    throw new Error('Answer too large for the relay channel');
  }
  const sealed = await encrypt(
    channel.key,
    answer,
    undefined,
    answerAad(channel.tag),
  );
  const { secretKey } = generateEphemeralKeys();
  const event = finalizeEvent(
    {
      // Same addressable kind the file relay probes and stores under, so a
      // relay that passed the probe accepts this too.
      kind: EVENT_KIND_FILE_CHUNK,
      content: uint8ArrayToBase64(sealed),
      tags: [
        ['d', answerDTag(channel.tag)],
        ['x', channel.tag],
        ['expiration', String(expiresAt)],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey,
  );

  let accepted = 0;
  let settle: (() => void) | undefined;
  const enough = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const attempts = relays.map(async (relay) => {
    for (let attempt = 0; attempt <= PUBLISH_MAX_RETRIES; attempt++) {
      try {
        await Promise.all(pool.publish([relay], event));
        accepted++;
        if (accepted >= ANSWER_PUBLISH_TARGET) settle?.();
        return;
      } catch {
        if (attempt < PUBLISH_MAX_RETRIES) {
          await sleep(PUBLISH_BACKOFF_BASE_MS * 2 ** attempt);
        }
      }
    }
  });

  // Every relay is tried — one acceptance can still be a relay that never
  // serves the event back — but a slow or hung one never holds the receiver
  // past the timeout, and enough acceptances end the wait immediately.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(attempts),
    enough,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ANSWER_PUBLISH_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));

  if (accepted === 0) {
    throw new Error('No relay accepted the response');
  }
}

export interface AnswerWatch {
  close(): void;
}

/**
 * Watch the channel for the receiver's sealed answer. Events that do not open
 * under the channel key are dropped silently — a relay may serve anything
 * filed under the tag, and only the offer holder's answer decrypts.
 * `onAnswer` fires at most once.
 */
export function watchForAnswer(
  pool: NostrFilePool,
  relays: string[],
  opts: {
    channel: AnswerChannel;
    /** unix seconds: subscription lower bound */
    since: number;
    onAnswer: (answer: Uint8Array) => void;
  },
): AnswerWatch {
  const { channel, onAnswer } = opts;
  const aad = answerAad(channel.tag);
  const dTag = answerDTag(channel.tag);
  let closed = false;

  const subscription: PoolSubscription = pool.subscribeMany(
    relays,
    {
      kinds: [EVENT_KIND_FILE_CHUNK],
      '#x': [channel.tag],
      since: opts.since,
    },
    {
      onevent: (event: Event) => {
        if (closed) return;
        if (event.tags.find((t) => t[0] === 'd')?.[1] !== dTag) return;
        // Cap before allocating: base64 of a sealed answer plus overhead.
        if (event.content.length > ANSWER_MAX_BYTES * 2) return;
        let sealed: Uint8Array;
        try {
          const binary = atob(event.content);
          sealed = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            sealed[i] = binary.charCodeAt(i);
          }
        } catch {
          return;
        }
        void decrypt(channel.key, sealed, aad)
          .then((answer) => {
            if (closed || answer.length > ANSWER_MAX_BYTES) return;
            closed = true;
            subscription.close();
            onAnswer(answer);
          })
          .catch(() => {
            // Not sealed under this offer's secret — ignore.
          });
      },
    },
  );

  return {
    close() {
      if (closed) return;
      closed = true;
      subscription.close();
    },
  };
}
