import type { Event } from 'nostr-tools';
import {
  type AcceptedOffer,
  acceptOffer,
  readOffer,
  sameTransferMetadata,
} from '@/lib/code-exchange/receive';
import {
  computePinHintFromLocator,
  deriveConfirmationCode,
  deriveHandshakeSealKeys,
  derivePinSessionKeys,
  finishPake,
  getPinBucket,
  isRendezvousFresh,
  isValidPakeMessage,
  MAX_CLAIM_ATTEMPTS,
  MAX_CLAIM_CANDIDATES,
  MAX_MESSAGE_SIZE,
  PIN_HINT_LOOKBACK_BUCKETS,
  startPake,
  wipeBufferSource,
} from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import {
  base64ToUint8Array,
  type ClaimPayload,
  type ConfirmPayload,
  computeRendezvousTranscriptHash,
  computeTransferMetadataHash,
  createHandshakeEvent,
  EVENT_KIND_DATA_TRANSFER,
  EVENT_KIND_RENDEZVOUS,
  generateEphemeralKeys,
  generateHandshakeNonce,
  type NostrClient,
  openHandshakePayload,
  parseHandshakeEvent,
  parseRendezvousEvent,
  type RendezvousPayload,
  sealHandshakePayload,
  type TransferMetadata,
} from '@/lib/nostr';
import { PROTOCOL_VERSION } from '@/lib/protocol-version';
import { mismatchedProtocol } from './send';

/**
 * The receiving half of a PIN Exchange handshake: finding the sender by the
 * PIN that was read out, proving knowledge of it with SPAKE2, and showing the
 * confirmation code that lets the two humans agree they found each other.
 *
 * Past that the session carries a Code Exchange offer and answer over its
 * sealed channel, and `lib/code-exchange/receive.ts` takes over.
 */

/**
 * Time to wait for the sender's confirm after publishing the claims. The
 * sender confirms as soon as a claim verifies — no human is in this leg — so
 * this only needs to cover relay latency. It is also the window in which a
 * mistyped-but-checksum-valid PIN surfaces: such a claim is silently ignored
 * by the sender, and this timeout is the only signal the receiver gets.
 */
const CONFIRM_TIMEOUT_MS = 60000;

/**
 * Time to wait for the sender's offer after its confirm.
 *
 * Generous because a human is in the loop here: the sender publishes nothing
 * past the confirm until its operator types the confirmation code this side
 * is displaying. The budget has to cover reading eight characters aloud over
 * a phone call and someone typing them back.
 *
 * The sender's own entry deadline is shorter than this window, so it normally
 * expires before this side gives up on an offer when no matching code is
 * entered.
 */
export const OFFER_WAIT_TIMEOUT_MS = 180000;

/**
 * How long the direct route may take to open when a fallback can take over
 * if it does not. No human carries this side's answer — it reaches the sender
 * within seconds — so the sender's own window is already running, and this
 * outlasts it just enough that the sender's verdict on the route comes first.
 */
export const DIRECT_ATTEMPT_TIMEOUT_MS = 30000;

/**
 * The same with nothing to fall back to: a dead route then simply fails the
 * transfer, so the wait matches the sender's backstop rather than cutting it
 * short.
 */
export const NO_FALLBACK_ATTEMPT_TIMEOUT_MS = 120000;

/**
 * One rendezvous candidate the receiver has run its side of the PAKE against
 * and claimed. The hint is a filter, not an identifier, and the rendezvous is
 * plaintext, so the receiver cannot know which candidate is its sender until
 * a confirm opens under one of these sessions' keys.
 */
interface ClaimCandidate {
  transferId: string;
  senderPubkey: string;
  senderNonce: string;
  receiverNonce: string;
  salt: Uint8Array;
  transcriptHash: string;
  /** Non-extractable HKDF root of this candidate's SPAKE2 session. */
  rootKey: CryptoKey;
  /** Seal key an authentic confirm from this candidate must open under. */
  confirmKey: CryptoKey;
  claimEvent: Event;
}

/** What this side is doing while it looks for the sender and claims. */
export interface PinClaimReport {
  status: 'connecting' | 'receiving';
  message: string;
}

export interface PinClaimOptions {
  /** The signaling client, already connected to this PIN kind's pool. */
  client: NostrClient;
  /**
   * The PIN's SPAKE2 password scalar, wiped as soon as the claims settle. The
   * caller keeps its own reference only as a backstop for an early exit.
   */
  pakeSecret: Uint8Array;
  /** The PIN's public locator segment, which the rendezvous hint is keyed by. */
  locator: string;
  isCancelled: () => boolean;
  report: (update: PinClaimReport) => void;
}

/**
 * The session one claim won: the SPAKE2 agreement the sender confirmed, the
 * identities and nonces it is bound to, and the metadata its confirm
 * delivered.
 */
export interface PinReceiverSession {
  transferId: string;
  senderPubkey: string;
  /** This side's ephemeral Nostr identity, which the claims were published under. */
  secretKey: Uint8Array;
  publicKey: string;
  salt: Uint8Array;
  senderNonce: string;
  receiverNonce: string;
  transcriptHash: string;
  /** Non-extractable HKDF root of the agreed SPAKE2 session. */
  rootKey: CryptoKey;
  /** What the sender says it is sending, sealed under the session's confirm key. */
  metadata: TransferMetadata;
}

/**
 * Find the sender this PIN points at, prove knowledge of the PIN, and wait
 * for the confirm that settles which candidate was real.
 *
 * Resolves with the locked session, or null once the caller has cancelled.
 * Every other ending is a throw whose message is what the person should be
 * told.
 */
export async function claimPin(
  options: PinClaimOptions,
): Promise<PinReceiverSession | null> {
  const { client, pakeSecret, locator, isCancelled, report } = options;

  report({ status: 'connecting', message: 'Deriving lookup keys...' });

  // Mirror the sender's acceptance rule by deriving the receiver's current and
  // immediately previous rotation buckets. Nothing here waits on a key stretch
  // — with the PAKE there is none.
  const currentBucket = getPinBucket();
  const hints = await Promise.all(
    Array.from({ length: PIN_HINT_LOOKBACK_BUCKETS + 1 }, (_, offset) =>
      computePinHintFromLocator(locator, currentBucket - offset),
    ),
  );

  if (isCancelled()) return null;

  report({ status: 'receiving', message: 'Searching for sender...' });

  // The hint is derived from the PIN's public locator segment, so it carries
  // only ~17.3 bits and unrelated transfers sharing a bucket do collide. The
  // rendezvous is plaintext, so nothing here can tell which candidate is our
  // sender — the loop below claims several and lets the handshake decide, but
  // a tight limit could truncate the real event away before it gets there.
  //
  // A flood of forged events sharing the tag can still push the real one out
  // of this page. That is a stall, not a compromise — a forged candidate's
  // confirm can never open under our session keys, so truncation ends in "no
  // transfer found" or a confirm timeout, never in the wrong event being
  // accepted. Paginating instead would not fix it: whoever can forge 50 events
  // can forge 50,000, and chasing pages would hand an attacker an unbounded
  // loop. See docs/ARCHITECTURE.md, "Availability Is a Non-Goal".
  const events = await client.query([
    { kinds: [EVENT_KIND_RENDEZVOUS], '#h': hints, limit: 50 },
  ]);

  if (isCancelled()) return null;

  if (events.length === 0) {
    throw new Error(
      'No transfer found for this PIN. It may have rotated — check the code currently shown on the sender.',
    );
  }

  // Collect structurally valid candidates, newest first, one per transfer (the
  // sender's current and previous rotation both match our hints and share a
  // transferId — claim only the newest generation).
  let sawExpiredCandidate = false;
  // A sender on another protocol, kept only to say so if nothing else is
  // claimable. The hint collides across unrelated transfers, so this cannot
  // refuse on its own: a compatible candidate beside it is still claimed.
  let otherProtocol: Partial<RendezvousPayload> | null = null;
  const sortedEvents = [...events].sort(
    (a, b) => (b.created_at || 0) - (a.created_at || 0),
  );

  interface RendezvousCandidate {
    payload: RendezvousPayload;
    salt: Uint8Array;
    senderPubkey: string;
    pakeMessage: Uint8Array;
  }

  // Structural validation only — with a plaintext rendezvous there is nothing
  // to authenticate yet. The payload must have been published in a bucket the
  // sender still honors and must name the event's own author and transfer id,
  // so a copied payload republished under another identity is rejected, and
  // the SPAKE2 element must be a valid non-identity curve point. Shared
  // between the initial fetch and replacement events that arrive while waiting
  // for the confirm.
  const parseClaimableRendezvous = (
    event: Event,
  ): RendezvousCandidate | null => {
    if (!isRendezvousFresh(event.created_at)) return null;
    const parsed = parseRendezvousEvent(event);
    if (!parsed) return null;
    const candidate = parsed.payload as Partial<RendezvousPayload>;
    if (
      candidate.type !== 'rendezvous' ||
      candidate.protocolVersion !== PROTOCOL_VERSION ||
      candidate.transferId !== parsed.transferId ||
      candidate.senderPubkey !== event.pubkey ||
      typeof candidate.nonce !== 'string' ||
      !candidate.nonce ||
      typeof candidate.pakeMessage !== 'string'
    ) {
      return null;
    }
    let pakeMessage: Uint8Array;
    try {
      pakeMessage = base64ToUint8Array(candidate.pakeMessage);
    } catch {
      return null;
    }
    if (!isValidPakeMessage(pakeMessage)) return null;
    return {
      payload: candidate as RendezvousPayload,
      salt: parsed.salt,
      senderPubkey: event.pubkey,
      pakeMessage,
    };
  };

  const rendezvousCandidates = new Map<string, RendezvousCandidate>();

  const now = Date.now();
  for (const event of sortedEvents) {
    if (rendezvousCandidates.size >= MAX_CLAIM_CANDIDATES) break;

    // A rendezvous event is only claimable while the sender still honors the
    // bucket it was published in. Tracked here (not in the shared helper) so
    // the "PIN expired" message can distinguish a rotated transfer. Only a
    // bucket in the past means the PIN moved on: a future-dated event is
    // forged or badly clocked, and telling the user to retype would send them
    // after the wrong problem.
    if (!isRendezvousFresh(event.created_at, now)) {
      if (
        event.created_at &&
        getPinBucket(event.created_at * 1000) < getPinBucket(now)
      ) {
        sawExpiredCandidate = true;
      }
      continue;
    }

    const candidate = parseClaimableRendezvous(event);
    if (!candidate) {
      const published = parseRendezvousEvent(event)?.payload as
        | Partial<RendezvousPayload>
        | undefined;
      if (
        published?.type === 'rendezvous' &&
        published.protocolVersion !== PROTOCOL_VERSION
      ) {
        otherProtocol ??= published;
      }
      continue;
    }
    if (rendezvousCandidates.has(candidate.payload.transferId)) continue;

    rendezvousCandidates.set(candidate.payload.transferId, candidate);
  }

  if (rendezvousCandidates.size === 0) {
    if (otherProtocol) {
      throw new Error(mismatchedProtocol('sender', otherProtocol));
    }
    throw new Error(
      sawExpiredCandidate
        ? 'This PIN has expired. Enter the code currently shown on the sender.'
        : 'No claimable transfer found for this PIN. Check the code currently shown on the sender.',
    );
  }

  if (isCancelled()) return null;

  // Claim every candidate: run our side of the SPAKE2 exchange against each
  // one's element and seal a claim under the resulting session's claim key.
  // Opening that seal is the sender's proof we know the PIN. Only the
  // candidate our sender actually published will ever answer with a confirm
  // that opens under its session's confirm key.
  //
  // Each claim hands whoever authored that candidate one online PIN guess — an
  // unavoidable property of any PAKE, bounded here by MAX_CLAIM_CANDIDATES
  // against a 2^46.3 space.
  const { secretKey, publicKey } = generateEphemeralKeys();

  report({
    status: 'receiving',
    message: 'Waiting for the sender to verify...',
  });

  // Run our side of the PAKE against one candidate's element — fresh ephemeral
  // scalar per claim — and seal a claim under the resulting session's claim
  // key. The transcript hash of the rendezvous we actually acted on rides
  // twice: sealed (the sender compares it with what it published and drops the
  // claim on any difference, so a republished rendezvous with any altered field
  // never reaches the point where the two humans compare codes) and in
  // plaintext as the claim's target, routing the claim to the single-use
  // element it was derived against.
  const buildClaim = async (
    rc: RendezvousCandidate,
  ): Promise<ClaimCandidate | null> => {
    try {
      const { message: ownMessage, secret } = startPake('receiver', pakeSecret);
      const rootKey = await finishPake(
        'receiver',
        secret,
        pakeSecret,
        ownMessage,
        rc.pakeMessage,
        {
          transferId: rc.payload.transferId,
          senderPubkey: rc.senderPubkey,
          receiverPubkey: publicKey,
        },
      );
      const { claimKey, confirmKey } = await deriveHandshakeSealKeys(
        rootKey,
        rc.salt,
      );

      const transcriptHash = await computeRendezvousTranscriptHash(
        rc.payload,
        rc.salt,
      );
      const receiverNonce = generateHandshakeNonce();

      const claimPayload: ClaimPayload = {
        type: 'claim',
        protocolVersion: PROTOCOL_VERSION,
        transferId: rc.payload.transferId,
        senderNonce: rc.payload.nonce,
        receiverNonce,
        senderPubkey: rc.senderPubkey,
        receiverPubkey: publicKey,
        transcriptHash,
      };
      return {
        transferId: rc.payload.transferId,
        senderPubkey: rc.senderPubkey,
        senderNonce: rc.payload.nonce,
        receiverNonce,
        salt: rc.salt,
        transcriptHash,
        rootKey,
        confirmKey,
        claimEvent: createHandshakeEvent(
          secretKey,
          rc.senderPubkey,
          rc.payload.transferId,
          'claim',
          await sealHandshakePayload(claimKey, claimPayload),
          ownMessage,
          transcriptHash,
        ),
      };
    } catch {
      // A candidate whose element fails the PAKE is simply skipped.
      return null;
    }
  };

  const candidates: ClaimCandidate[] = [];
  for (const rc of rendezvousCandidates.values()) {
    const claim = await buildClaim(rc);
    if (claim) candidates.push(claim);
  }
  // The password scalar stays live past this point: the sender's elements are
  // single-use, so a claim that lost a race is answered with a replacement
  // rendezvous we must re-derive against. It is wiped as soon as the confirm
  // wait settles.

  if (candidates.length === 0) {
    throw new Error(
      'No claimable transfer found for this PIN. Check the code currently shown on the sender.',
    );
  }

  if (isCancelled()) return null;

  // Subscribe for confirms before publishing the claims so the response cannot
  // slip past us. The first confirm that opens under one of our sessions'
  // confirm keys — and echoes everything that session committed to — decides
  // which candidate was real. While waiting, also watch for replacement
  // rendezvous events: the sender's elements are single-use, so if a junk
  // claim spent the element we claimed, the sender publishes a fresh one and
  // our claim must be redone against it.
  const winnerPromise = new Promise<{
    candidate: ClaimCandidate;
    metadata: TransferMetadata;
  }>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cancelPoll: ReturnType<typeof setInterval> | null = null;
    let queryPoll: ReturnType<typeof setInterval> | null = null;
    let subId: string | null = null;
    let rendezvousSubId: string | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (cancelPoll) clearInterval(cancelPoll);
      if (queryPoll) clearInterval(queryPoll);
      if (subId) client.unsubscribe(subId);
      if (rendezvousSubId) client.unsubscribe(rendezvousSubId);
      timeout = null;
      cancelPoll = null;
      queryPoll = null;
      subId = null;
      rendezvousSubId = null;
    };

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          'Sender did not confirm. The transfer may have been claimed by another device, the sender may have gone offline, or the PIN was mistyped.',
        ),
      );
    }, CONFIRM_TIMEOUT_MS);

    cancelPoll = setInterval(() => {
      if (isCancelled() && !settled) {
        settled = true;
        cleanup();
        reject(new Error('Cancelled'));
      }
    }, 250);

    const processedEventIds = new Set<string>();

    const processEvent = (event: Event) => {
      if (settled || isCancelled()) return;
      if (processedEventIds.has(event.id)) return;
      processedEventIds.add(event.id);

      const handshake = parseHandshakeEvent(event);
      if (!handshake || handshake.type !== 'confirm') return;
      // A re-claim shares its transfer id and author with the claim it
      // replaced, so several claimed candidates can match one confirm — only
      // the session the sender actually verified holds the key that opens it,
      // so every match must be tried, not just the first.
      const matching = candidates.filter(
        (c) =>
          c.transferId === handshake.transferId &&
          c.senderPubkey === event.pubkey,
      );
      if (matching.length === 0) return;

      void (async () => {
        for (const candidate of matching) {
          let opened: unknown;
          try {
            opened = await openHandshakePayload(
              candidate.confirmKey,
              handshake.sealedPayload,
            );
          } catch {
            continue; // Not sealed by our PAKE peer for this candidate
          }

          const p = opened as Partial<ConfirmPayload>;
          const m = p.metadata as Partial<TransferMetadata> | undefined;
          if (
            p.type !== 'confirm' ||
            p.transferId !== candidate.transferId ||
            p.senderNonce !== candidate.senderNonce ||
            p.receiverNonce !== candidate.receiverNonce ||
            p.senderPubkey !== event.pubkey ||
            p.receiverPubkey !== publicKey ||
            p.transcriptHash !== candidate.transcriptHash ||
            !m ||
            m.contentType !== 'file' ||
            typeof m.fileName !== 'string' ||
            typeof m.mimeType !== 'string' ||
            typeof m.fileSize !== 'number' ||
            !Number.isFinite(m.fileSize) ||
            m.fileSize < 0 ||
            (m.contentEncoding !== 'deflate-raw' &&
              m.contentEncoding !== 'identity')
          ) {
            continue;
          }

          if (settled) return;
          settled = true;
          cleanup();
          resolve({ candidate, metadata: m as TransferMetadata });
          return;
        }
      })();
    };

    subId = client.subscribe(
      [
        {
          kinds: [EVENT_KIND_DATA_TRANSFER],
          '#t': candidates.map((c) => c.transferId),
          '#p': [publicKey],
          authors: candidates.map((c) => c.senderPubkey),
        },
      ],
      processEvent,
    );

    // Re-claim replacements. Only an event authored by the same key that
    // published a rendezvous we already claimed counts — a forged
    // "replacement" under another identity is just another candidate we never
    // claimed. Each re-claim still hands its author one online PIN guess, so
    // the total is capped: a claimed candidate's author rotating elements at us
    // gets at most MAX_CLAIM_ATTEMPTS guesses per receive attempt, not an
    // unbounded stream.
    let claimAttempts = candidates.length;
    const claimedHashes = new Set(candidates.map((c) => c.transcriptHash));
    const processedRendezvousIds = new Set<string>();

    const processReplacement = (event: Event) => {
      if (settled || isCancelled()) return;
      if (processedRendezvousIds.has(event.id)) return;
      processedRendezvousIds.add(event.id);

      // Match the tag-level transfer id and the event author against the
      // claimed candidates before doing any parse work — the hint subscription
      // is public, so anyone can land events here, and an unrelated one must
      // cost a tag read, not JSON parsing and curve point validation.
      // parseClaimableRendezvous re-checks that the payload names this same tag
      // and author, so nothing is lost.
      const transferId = event.tags.find((t) => t[0] === 't')?.[1];
      if (
        !transferId ||
        !candidates.some(
          (c) => c.transferId === transferId && c.senderPubkey === event.pubkey,
        )
      ) {
        return;
      }
      const rc = parseClaimableRendezvous(event);
      if (!rc) return;

      void (async () => {
        try {
          const transcriptHash = await computeRendezvousTranscriptHash(
            rc.payload,
            rc.salt,
          );
          if (settled || isCancelled()) return;
          if (claimedHashes.has(transcriptHash)) return;
          if (claimAttempts >= MAX_CLAIM_ATTEMPTS) return;
          claimAttempts += 1;
          claimedHashes.add(transcriptHash);

          const claim = await buildClaim(rc);
          if (!claim || settled || isCancelled()) return;
          // The confirm subscription and poll already cover this claim: its
          // transfer id and author match the original candidate's.
          candidates.push(claim);
          await client.publish(claim.claimEvent);
        } catch (err) {
          console.error('Failed to re-claim replacement rendezvous:', err);
        }
      })();
    };

    rendezvousSubId = client.subscribe(
      [{ kinds: [EVENT_KIND_RENDEZVOUS], '#h': hints }],
      processReplacement,
    );

    const publishAndPoll = async () => {
      for (const candidate of candidates) {
        await client.publish(candidate.claimEvent);
      }
      if (settled || isCancelled()) return;
      // Backstop for relays that processed the publish before the
      // subscription: poll for an already-stored confirm.
      queryPoll = setInterval(() => {
        if (settled || isCancelled()) return;
        void (async () => {
          try {
            const existing = await client.query([
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': candidates.map((c) => c.transferId),
                '#p': [publicKey],
                authors: candidates.map((c) => c.senderPubkey),
                limit: 10,
              },
            ]);
            for (const event of existing) processEvent(event);
          } catch (err) {
            console.error('Failed to query for confirm event:', err);
          }
        })();
      }, 3000);
    };

    void (async () => {
      try {
        await publishAndPoll();
      } catch (err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error('Publish failed'));
      }
    })();
  });

  let winner: Awaited<typeof winnerPromise>;
  try {
    winner = await winnerPromise;
  } finally {
    // Win or lose, no *new* re-claim can start once the winner promise
    // settles. A processReplacement re-claim already past its settled check
    // can still be in flight, though, and its buildClaim may observe the wiped
    // scalar — benignly: the claim it derives could never verify anyway, and
    // the settled re-checks after each await keep it from being published.
    wipeBufferSource(pakeSecret);
  }

  if (isCancelled()) return null;

  const { candidate, metadata } = winner;
  if (metadata.fileSize > MAX_MESSAGE_SIZE) {
    throw new Error(
      `Transfer rejected: Size (${formatFileSize(metadata.fileSize)}) exceeds limit (${formatFileSize(MAX_MESSAGE_SIZE)})`,
    );
  }

  return {
    transferId: candidate.transferId,
    senderPubkey: candidate.senderPubkey,
    secretKey,
    publicKey,
    salt: candidate.salt,
    senderNonce: candidate.senderNonce,
    receiverNonce: candidate.receiverNonce,
    transcriptHash: candidate.transcriptHash,
    rootKey: candidate.rootKey,
    metadata,
  };
}

/** What the locked session owes this side, once the confirm has opened. */
export interface PinReceiverConfirmation {
  /**
   * The code to read out to the sender. Someone who front-ran us with a stolen
   * PIN holds a different SPAKE2 session, so the code on their screen is not
   * the one the sender is about to be told.
   */
  confirmationCode: string;
  /** Seals the offer the sender carries once it has the code, and the answer back. */
  signalsKey: CryptoKey;
}

/**
 * The confirmation code for a locked session, and the key that seals the codes
 * it carries.
 *
 * The confirm proved the sender ran our PAKE session, and its sealed metadata
 * is now on the table. The sender publishes nothing further — no connection
 * offer, no file byte — until its operator types this code.
 */
export async function pinReceiverConfirmation(
  session: PinReceiverSession,
): Promise<PinReceiverConfirmation> {
  const metadataHash = await computeTransferMetadataHash(session.metadata);
  const [confirmationCode, { signals }] = await Promise.all([
    deriveConfirmationCode(session.rootKey, session.salt, {
      transferId: session.transferId,
      senderNonce: session.senderNonce,
      receiverNonce: session.receiverNonce,
      transcriptHash: session.transcriptHash,
      metadataHash,
    }),
    derivePinSessionKeys(session.rootKey, session.salt),
  ]);
  return { confirmationCode, signalsKey: signals };
}

/**
 * Take in the connection offer the sender carried over the sealed channel,
 * once the humans have compared their codes.
 *
 * Two rules past the ordinary Code Exchange ones, both of which this side can
 * only check here: the offer must describe the same file the confirm did —
 * the code the humans compared is bound to that metadata — and its fallback
 * must stay on the side of the privacy line the PIN's kind drew. An anonymous
 * transfer never hands either device's address to a clearnet relay, and an
 * ordinary one has no Tor client to run the other kind.
 */
export async function acceptPinOffer(
  offerCode: Uint8Array,
  expected: { metadata: TransferMetadata; anonymous: boolean },
): Promise<AcceptedOffer> {
  const offer = acceptOffer(await readOffer(offerCode));
  if (!sameTransferMetadata(offer.metadata, expected.metadata)) {
    throw new Error(
      "The sender's connection offer describes a different file than it confirmed. Start a new transfer.",
    );
  }
  if (
    offer.fallback !== 'none' &&
    offer.fallback !== (expected.anonymous ? 'anonymous' : 'relay')
  ) {
    throw new Error(
      expected.anonymous
        ? "The sender's connection offer asks for a clearnet fallback, which anonymous signaling never uses. Start a new transfer."
        : "The sender's connection offer asks for the Tor fallback, which only an anonymous PIN uses. Start a new transfer.",
    );
  }
  return offer;
}
