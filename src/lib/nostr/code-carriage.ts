import type { Event, Filter } from 'nostr-tools';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../base64';
import { decrypt, encrypt } from '../crypto/aes-gcm';
import { createSignalingEvent, parseSignalingEvent } from './events';
import { EVENT_KIND_DATA_TRANSFER } from './types';

/**
 * PIN Exchange carrying Code Exchange's two codes.
 *
 * Once the PIN handshake has locked a receiver and the sender's operator has
 * typed that receiver's confirmation code, the two sides run a Code Exchange
 * session — the same PT01 offer, ECDH agreement, answer confirmation tag,
 * direct attempt and fallbacks. The only difference is how the codes travel:
 * not handed over by a person, but sealed under the PAKE session's signals key
 * inside the kind-24243 signal events this mode already uses.
 *
 * Each code rides verbatim. The answer's confirmation tag is bound to a digest
 * of the offer's container bytes, so both sides must hash the same bytes, and
 * carrying the container unchanged is what guarantees it.
 *
 * The seal is what authenticates the codes here, where a person's hand does in
 * Code Exchange: only the two ends of the locked PAKE session hold the signals
 * key, and the sender publishes nothing sealed under it until the confirmation
 * code matched.
 */

export type CarriedCodeType = 'offer' | 'answer';

export interface CarriedCode {
  type: CarriedCodeType;
  /** The PT01 container, byte for byte. */
  code: Uint8Array;
}

/** Seal one code under the session's signals key. */
export async function sealCarriedCode(
  signalsKey: CryptoKey,
  carried: CarriedCode,
): Promise<Uint8Array> {
  const json = JSON.stringify({
    type: carried.type,
    code: uint8ArrayToBase64(carried.code),
  });
  return await encrypt(signalsKey, new TextEncoder().encode(json));
}

/**
 * Open a sealed code. Returns null for anything that does not open under the
 * signals key or is not shaped as a code — never throws, since a relay can
 * put anything in front of this.
 */
export async function openCarriedCode(
  signalsKey: CryptoKey,
  sealed: Uint8Array,
): Promise<CarriedCode | null> {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder().decode(await decrypt(signalsKey, sealed)),
    );
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { type, code } = value as Record<string, unknown>;
  if ((type !== 'offer' && type !== 'answer') || typeof code !== 'string') {
    return null;
  }
  try {
    return { type, code: base64ToUint8Array(code) };
  } catch {
    return null;
  }
}

/** The part of `NostrClient` the carriage uses. */
export interface CarriageClient {
  publish(event: Event): Promise<void>;
  subscribe(filters: Filter[], onEvent: (event: Event) => void): string;
  unsubscribe(subId: string): void;
  query(filters: Filter[]): Promise<Event[]>;
}

/** One side's view of the locked session the codes travel on. */
export interface CarriageSession {
  client: CarriageClient;
  /** This side's ephemeral Nostr secret key. */
  secretKey: Uint8Array;
  transferId: string;
  /** Every code event is tagged with the sender's pubkey, both directions. */
  senderPubkey: string;
  /** The PAKE session's signals key. */
  signalsKey: CryptoKey;
  isCancelled: () => boolean;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Sender: publish the offer and wait for the locked receiver's answer.
 *
 * The offer is republished every `retryMs` until an answer arrives, so a relay
 * that missed it does not strand the session; the receiver answers every
 * repeat of the offer it answered. Resolves with the first answer code that
 * opens under the signals key — which only the locked receiver can have
 * sealed — and leaves checking it to the caller.
 */
export function carryOfferForAnswer(
  opts: CarriageSession & {
    receiverPubkey: string;
    offer: Uint8Array;
    retryMs: number;
    timeoutMs: number;
  },
): Promise<Uint8Array> {
  const { client, transferId, senderPubkey, receiverPubkey, signalsKey } = opts;
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    let subId: string | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cancelPoll: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const processed = new Set<string>();
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(retry);
      clearInterval(cancelPoll);
      clearTimeout(timeout);
      if (subId) client.unsubscribe(subId);
      outcome();
    };

    subId = client.subscribe(
      [
        {
          kinds: [EVENT_KIND_DATA_TRANSFER],
          '#t': [transferId],
          '#p': [senderPubkey],
          authors: [receiverPubkey],
        },
      ],
      (event) => {
        if (settled || processed.has(event.id)) return;
        processed.add(event.id);
        if (event.pubkey !== receiverPubkey) return;
        const signal = parseSignalingEvent(event);
        if (!signal || signal.transferId !== transferId) return;
        void (async () => {
          const carried = await openCarriedCode(
            signalsKey,
            signal.encryptedSignal,
          );
          if (carried?.type === 'answer') {
            finish(() => resolve(carried.code));
          }
        })();
      },
    );

    const publishOffer = async () => {
      const sealed = await sealCarriedCode(signalsKey, {
        type: 'offer',
        code: opts.offer,
      });
      if (settled) return;
      await client.publish(
        createSignalingEvent(opts.secretKey, senderPubkey, transferId, sealed),
      );
    };

    // Each repeat is scheduled once the previous publish has finished, so a
    // slow relay never has two of them in flight at once.
    const scheduleRetry = () => {
      if (settled) return;
      retry = setTimeout(() => {
        if (settled) return;
        void (async () => {
          try {
            await publishOffer();
          } catch (error: unknown) {
            console.error('Failed to republish the connection offer:', error);
          } finally {
            scheduleRetry();
          }
        })();
      }, opts.retryMs);
    };
    timeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            'The receiver did not answer the connection offer. Start a new transfer.',
          ),
        ),
      );
    }, opts.timeoutMs);
    cancelPoll = setInterval(() => {
      if (opts.isCancelled()) finish(() => reject(new Error('Cancelled')));
    }, 250);

    // The first publish failing means no relay took the offer at all; the
    // repeats are best-effort on top of one that did.
    void (async () => {
      try {
        await publishOffer();
      } catch (error: unknown) {
        finish(() =>
          reject(error instanceof Error ? error : new Error('Publish failed')),
        );
        return;
      }
      scheduleRetry();
    })();
  });
}

/** Receiver: the wait for the sender's offer, and the answer that goes back. */
export interface CarriedOfferWait {
  /** The sender's offer code, the first time one arrives. */
  offer: Promise<Uint8Array>;
  /**
   * Publish this side's answer now, and again whenever the sender repeats the
   * offer it answers.
   */
  answer(code: Uint8Array): Promise<void>;
  /** Stop listening. An offer still awaited rejects. */
  close(): void;
}

/**
 * Receiver: wait for the sender's sealed offer.
 *
 * The first offer that opens under the signals key is the one this side acts
 * on; a later, different one is ignored, since a session answers exactly one
 * offer. A repeat of that same offer means the sender has not seen the answer
 * yet, and is answered again.
 */
export function awaitCarriedOffer(
  opts: CarriageSession & {
    timeoutMs: number;
    /** The rejection when no offer arrives within `timeoutMs`. */
    timeoutMessage: string;
  },
): CarriedOfferWait {
  const { client, transferId, senderPubkey, signalsKey } = opts;
  let closed = false;
  let first: Uint8Array | null = null;
  let sealedAnswer: Uint8Array | null = null;
  const processed = new Set<string>();

  let resolveOffer!: (code: Uint8Array) => void;
  let rejectOffer!: (error: Error) => void;
  let offerSettled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  const offer = new Promise<Uint8Array>((resolve, reject) => {
    resolveOffer = resolve;
    rejectOffer = reject;
  });
  // Nothing may be awaiting this when close() rejects it.
  void offer.catch(() => {});
  const settleOffer = (outcome: () => void) => {
    if (offerSettled) return;
    offerSettled = true;
    clearTimeout(timeout);
    clearInterval(cancelPoll);
    outcome();
  };

  const publishAnswer = async () => {
    if (!sealedAnswer || closed) return;
    await client.publish(
      createSignalingEvent(
        opts.secretKey,
        senderPubkey,
        transferId,
        sealedAnswer,
      ),
    );
  };

  const onEvent = (event: Event) => {
    if (closed || processed.has(event.id)) return;
    processed.add(event.id);
    if (event.pubkey !== senderPubkey) return;
    const signal = parseSignalingEvent(event);
    if (!signal || signal.transferId !== transferId) return;
    void (async () => {
      const carried = await openCarriedCode(signalsKey, signal.encryptedSignal);
      if (closed || carried?.type !== 'offer') return;
      if (!first) {
        first = carried.code;
        settleOffer(() => resolveOffer(carried.code));
        return;
      }
      if (!sameBytes(carried.code, first)) return;
      try {
        await publishAnswer();
      } catch (error: unknown) {
        console.error('Failed to republish the answer:', error);
      }
    })();
  };

  const filter: Filter = {
    kinds: [EVENT_KIND_DATA_TRANSFER],
    '#t': [transferId],
    authors: [senderPubkey],
  };
  const subId = client.subscribe([filter], onEvent);
  // Backstop for a relay that delivered the offer before the subscription
  // was in place and kept it.
  void (async () => {
    try {
      for (const event of await client.query([{ ...filter, limit: 50 }])) {
        onEvent(event);
      }
    } catch (error: unknown) {
      console.error('Failed to query for an earlier offer:', error);
    }
  })();

  const close = () => {
    if (closed) return;
    closed = true;
    client.unsubscribe(subId);
    settleOffer(() => rejectOffer(new Error('Cancelled')));
  };

  // A wait that ended without an offer has nothing left to listen for.
  timeout = setTimeout(() => {
    settleOffer(() => rejectOffer(new Error(opts.timeoutMessage)));
    close();
  }, opts.timeoutMs);
  cancelPoll = setInterval(() => {
    if (opts.isCancelled()) close();
  }, 250);

  return {
    offer,
    async answer(code) {
      sealedAnswer = await sealCarriedCode(signalsKey, {
        type: 'answer',
        code,
      });
      await publishAnswer();
    },
    close,
  };
}
