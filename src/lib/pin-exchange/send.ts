import type { Event } from 'nostr-tools';
import {
  CLAIM_VERIFY_LIMIT,
  computePinHintFromLocator,
  constantTimeEqual,
  deriveConfirmationCode,
  deriveHandshakeSealKeys,
  derivePakeSecret,
  derivePinSessionKeys,
  finishPake,
  generatePin,
  generateSalt,
  generateTransferId,
  getPinBucket,
  getPinLocator,
  isPinBucketActive,
  normalizeCrockfordBase32,
  PIN_ROTATION_MS,
  PIN_WAIT_TIMEOUT_MS,
  type PinKind,
  startPake,
  wipeBufferSource,
} from '@/lib/crypto';
import {
  type ClaimPayload,
  type ConfirmPayload,
  computeRendezvousTranscriptHash,
  computeTransferMetadataHash,
  createHandshakeEvent,
  createRendezvousEvent,
  EVENT_KIND_DATA_TRANSFER,
  generateEphemeralKeys,
  generateHandshakeNonce,
  type NostrClient,
  openHandshakePayload,
  parseHandshakeEvent,
  type RendezvousPayload,
  sealHandshakePayload,
  type TransferMetadata,
  uint8ArrayToBase64,
} from '@/lib/nostr';

/**
 * The sending half of a PIN Exchange handshake: the rotating rendezvous a
 * receiver finds by the PIN it was read, the SPAKE2 run that proves it knew
 * one, and the confirmation code the two humans compare before a byte moves.
 *
 * What the handshake sets up is a Code Exchange session — the very same offer
 * and answer, carried over this sealed channel instead of a person's hand
 * (see `lib/nostr/code-carriage.ts`). So everything here stops at the moment
 * the operator's code matches; `lib/code-exchange/send.ts` takes it from
 * there, on whichever host is running it.
 */

/**
 * Time the sender waits for its operator to type the receiver's confirmation
 * code before giving up on the locked claim.
 *
 * Shorter than the receiver's offer wait, so this sender-side deadline
 * normally expires first when no matching code is entered.
 */
export const CONFIRM_CODE_ENTRY_TIMEOUT_MS = 150000;

/**
 * Time the sender waits for the receiver's answer once its offer is out. No
 * human is in this leg: the receiver answers as soon as it has built one,
 * which takes a few seconds of candidate gathering.
 */
export const ANSWER_WAIT_TIMEOUT_MS = 60000;

/**
 * How often the offer is republished while no answer has come back, so a
 * relay that missed it does not strand the session.
 */
export const OFFER_RETRY_MS = 5000;

/**
 * One published SPAKE2 run: the ephemeral scalar x, its blinded element pA,
 * and the rendezvous fields it rode on. Strictly single-use (RFC 9382 §7): the
 * first claim targeting it consumes it — verified or not — and a consumed run
 * is replaced by publishing a replacement rendezvous with a fresh scalar,
 * never finished a second time.
 */
interface PakeRunState {
  /** SPAKE2 ephemeral scalar x behind the published element. */
  pakeEphemeral: bigint;
  /** The published SPAKE2 element pA (33-byte compressed point). */
  pakeMessage: Uint8Array;
  nonce: string;
  /** Digest of the published rendezvous; claims name it as their target. */
  transcriptHash: string;
}

/**
 * One rotation generation of the displayed PIN. Its absolute bucket lets the
 * sender reject it as soon as it is older than the immediately previous
 * bucket, regardless of timer delays or how many generations are retained.
 */
interface PinGeneration {
  /** SPAKE2 password scalar w for this generation's PIN (32 BE bytes). */
  pakeSecret: Uint8Array;
  bucket: number;
  /** Rendezvous hint for this generation's locator and bucket; fixed, so
   * replacement publications stay discoverable by the same receiver query. */
  hint: string;
  /**
   * The currently claimable run, or null after a claim consumed it while its
   * replacement publish is still in flight (or the budget is exhausted).
   */
  run: PakeRunState | null;
  /**
   * Remaining SPAKE2 claim verifications this generation will run. With a
   * PAKE, every verification attempt is exactly one online PIN guess for
   * whoever authored the claim, so this budget — not any key-stretching — is
   * the online guessing bound; it also caps the replacement publishes a claim
   * flood can force. Exhaustion stalls the generation (rotation mints a fresh
   * budget); see CLAIM_VERIFY_LIMIT.
   */
  verifyBudget: number;
}

/** A verified receiver claim: the transfer is locked to this peer. */
export interface VerifiedClaim {
  receiverPubkey: string;
  payload: ClaimPayload;
  /** Non-extractable HKDF root of the matching SPAKE2 session. */
  rootKey: CryptoKey;
  /** Seal key for the confirm this sender now owes the receiver. */
  confirmKey: CryptoKey;
}

export interface PinRendezvousOptions {
  /** The signaling client, already connected to this PIN kind's pool. */
  client: NostrClient;
  /**
   * Which kind of PIN to mint. Its length is the only thing that tells the
   * receiver which relay pool to look on, so it and the client's pool are
   * decided together and never separately.
   */
  pinKind: PinKind;
  /** The relay list the rendezvous names, which is the client's own. */
  relays: readonly string[];
  isCancelled: () => boolean;
  /**
   * A freshly minted PIN, to show. Called for the first one, for every
   * rotation, and for every `refresh()` — each one retires the last.
   */
  onPin: (pin: string) => void;
}

/**
 * A rotating PIN, published and waiting for a receiver to prove it knew one.
 *
 * The identity fields are this transfer's and are needed past the claim: the
 * confirm is published under `secretKey`, and the session keys are derived
 * against `salt`.
 */
export interface PinRendezvous {
  readonly transferId: string;
  readonly salt: Uint8Array;
  readonly secretKey: Uint8Array;
  readonly publicKey: string;
  /**
   * The first claim that proves knowledge of a live PIN, which locks the
   * transfer to its author. Rejects when the wait runs out, when a publish
   * fails outright, or once `close()` is called.
   */
  readonly claimed: Promise<VerifiedClaim>;
  /**
   * Mint and publish a fresh PIN immediately, retiring every PIN shown before
   * it, without touching the file, the keys, or the relay connections.
   */
  refresh(): Promise<void>;
  /**
   * Stop rotating and wipe every retained PAKE secret. Idempotent, and the
   * cleanup for every exit — the claim path has already retired its
   * generations by the time it resolves.
   */
  close(): void;
}

/**
 * Publish a rotating rendezvous for a freshly minted PIN and wait for the
 * claim that locks the transfer to one receiver.
 */
export function startPinRendezvous(
  options: PinRendezvousOptions,
): PinRendezvous {
  const { client, pinKind, relays, isCancelled, onPin } = options;

  // Per-transfer credentials for the handshake: public salt (HKDF input for
  // the session keys) and an ephemeral Nostr identity. The PIN authenticates
  // the SPAKE2 run; the content key comes later, out of the Code Exchange
  // agreement the handshake then carries.
  const salt = generateSalt();
  const { secretKey, publicKey } = generateEphemeralKeys();
  const transferId = generateTransferId();

  // Retained PIN generations, newest first.
  const generations: PinGeneration[] = [];

  // Rotate the PIN until a receiver proves knowledge of one of the retained
  // generations, then lock the transfer to that receiver. A manual refresh
  // bumps the epoch, so an in-flight rotation publish from before the reset can
  // neither register its generation nor be displayed.
  let pinEpoch = 0;

  // Best-effort cleanup for generations leaving the retained list: their PAKE
  // secret dies with them. The bigint ephemeral scalar cannot be wiped and is
  // simply dropped.
  const retireGenerations = (keep: (g: PinGeneration) => boolean) => {
    const kept = generations.filter(keep);
    for (const generation of generations) {
      if (!kept.includes(generation)) wipeBufferSource(generation.pakeSecret);
    }
    generations.splice(0, generations.length, ...kept);
  };

  // Start a fresh single-use SPAKE2 run and build the rendezvous event that
  // publishes its element. The element is blinded, and nothing here may be
  // PIN-testable offline. File metadata stays out and is delivered inside the
  // sealed confirm after the handshake. The transcript hash covers what we are
  // about to publish, so a claim can be checked against the rendezvous we
  // actually sent rather than the one the claimant says it saw — fresh per
  // publication, since the nonce and element are.
  const startRun = async (
    pakeSecret: Uint8Array,
    hint: string,
    bucket: number,
  ): Promise<{ run: PakeRunState; event: Event }> => {
    const { message: pakeMessage, secret: pakeEphemeral } = startPake(
      'sender',
      pakeSecret,
    );
    const nonce = generateHandshakeNonce();
    const payload: RendezvousPayload = {
      type: 'rendezvous',
      transferId,
      senderPubkey: publicKey,
      pakeMessage: uint8ArrayToBase64(pakeMessage),
      nonce,
      relays: [...relays],
    };
    const transcriptHash = await computeRendezvousTranscriptHash(payload, salt);
    const event = createRendezvousEvent(secretKey, payload, salt, hint, bucket);
    return {
      run: { pakeEphemeral, pakeMessage, nonce, transcriptHash },
      event,
    };
  };

  const publishRendezvous = async () => {
    const epoch = pinEpoch;
    const newPin = generatePin(pinKind);
    const bucket = getPinBucket();
    const [hint, pakeSecret] = await Promise.all([
      computePinHintFromLocator(getPinLocator(newPin), bucket),
      derivePakeSecret(newPin),
    ]);
    // Until the generation is registered below, this scope owns the secret:
    // wipe it on every exit — stale epoch, cancellation, or a throw anywhere
    // between derivation and registration.
    let registered = false;
    try {
      const { run, event } = await startRun(pakeSecret, hint, bucket);

      if (isCancelled() || epoch !== pinEpoch) return;

      // Register the generation before publishing so a fast claim can never
      // race ahead of the retained-keys list.
      generations.unshift({
        pakeSecret,
        bucket,
        hint,
        run,
        verifyBudget: CLAIM_VERIFY_LIMIT,
      });
      registered = true;
      retireGenerations((generation) => isPinBucketActive(generation.bucket));

      await client.publish(event);

      if (!isCancelled() && epoch === pinEpoch) onPin(newPin);
    } finally {
      if (!registered) wipeBufferSource(pakeSecret);
    }
  };

  // Replace a consumed element: same PIN, same bucket and hint, fresh
  // ephemeral scalar behind a fresh blinded element. Published after every
  // failed claim verification so the generation stays claimable — the honest
  // receiver that lost the race to a junk claim re-claims against this
  // replacement. Skipped once the budget is exhausted or the bucket has
  // expired, which is what stalls a flooded generation.
  const publishReplacement = async (generation: PinGeneration) => {
    const epoch = pinEpoch;
    if (generation.verifyBudget <= 0 || !isPinBucketActive(generation.bucket)) {
      return;
    }
    const { run, event } = await startRun(
      generation.pakeSecret,
      generation.hint,
      generation.bucket,
    );
    if (
      isCancelled() ||
      epoch !== pinEpoch ||
      !generations.includes(generation)
    ) {
      return;
    }
    // Assign before publishing, mirroring the fresh-PIN path: a receiver can
    // re-claim the moment any relay accepts the event, potentially before
    // publish() resolves here — and publish() rejecting does not mean no relay
    // accepted, so the run is retained even then. An element that truly never
    // left is merely inert: no claim can name its transcript hash, and rotation
    // replaces the generation anyway.
    generation.run = run;
    await client.publish(event);
  };

  let settled = false;
  let rotationInterval: ReturnType<typeof setInterval> | null = null;
  let cancelPoll: ReturnType<typeof setInterval> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let subId: string | null = null;
  // Assigned by the executor below, which runs before anything can call it.
  let giveUp!: (error: Error) => void;

  const cleanup = () => {
    if (rotationInterval) clearInterval(rotationInterval);
    if (cancelPoll) clearInterval(cancelPoll);
    if (timeout) clearTimeout(timeout);
    if (subId) client.unsubscribe(subId);
    rotationInterval = null;
    cancelPoll = null;
    timeout = null;
    subId = null;
    // Settling ends this transfer's rotation era: bump the epoch so an
    // in-flight publishRendezvous wakes up stale and aborts instead of
    // registering a generation, publishing after lockout, or re-displaying a
    // PIN.
    pinEpoch += 1;
  };

  const claimed = new Promise<VerifiedClaim>((resolve, reject) => {
    giveUp = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    timeout = setTimeout(() => {
      giveUp(new Error('No receiver connected. Please start a new transfer.'));
    }, PIN_WAIT_TIMEOUT_MS);

    cancelPoll = setInterval(() => {
      if (isCancelled()) giveUp(new Error('Cancelled'));
    }, 250);

    const processedEventIds = new Set<string>();

    subId = client.subscribe(
      [
        {
          kinds: [EVENT_KIND_DATA_TRANSFER],
          '#t': [transferId],
          '#p': [publicKey],
        },
      ],
      (event: Event) => {
        if (settled || isCancelled()) return;
        if (processedEventIds.has(event.id)) return;
        processedEventIds.add(event.id);

        const handshake = parseHandshakeEvent(event);
        if (
          !handshake ||
          handshake.type !== 'claim' ||
          handshake.transferId !== transferId ||
          !handshake.pakeMessage ||
          !handshake.target
        ) {
          return;
        }
        const claimPakeMessage = handshake.pakeMessage;

        // Route by the claim's plaintext target: it names the exact published
        // element the claim was derived against, so a claim whose target is
        // spent, expired, or was never ours costs nothing. A retained
        // generation has no authority outside the sender's current and
        // immediately previous wall-clock buckets, and each one runs at most
        // CLAIM_VERIFY_LIMIT verifications — every attempt is one online PIN
        // guess for the claim's author, and this counter is the only thing
        // bounding those guesses.
        const generation = generations.find(
          (candidate) =>
            isPinBucketActive(candidate.bucket) &&
            candidate.verifyBudget > 0 &&
            candidate.run?.transcriptHash === handshake.target,
        );
        const run = generation?.run;
        if (!generation || !run) return;
        // Consume the run before any await: the element is single-use, and a
        // concurrent claim naming the same target must find it already spent,
        // never finish the same scalar twice.
        generation.run = null;
        generation.verifyBudget -= 1;

        void (async () => {
          // Finish our side of the SPAKE2 run against the claimant's element,
          // then try the claim seal. A wrong PIN lands on a different root key
          // and the seal simply refuses to open.
          let verified: VerifiedClaim | null = null;
          try {
            const rootKey = await finishPake(
              'sender',
              run.pakeEphemeral,
              generation.pakeSecret,
              run.pakeMessage,
              claimPakeMessage,
              {
                transferId,
                senderPubkey: publicKey,
                receiverPubkey: event.pubkey,
              },
            );
            const sealKeys = await deriveHandshakeSealKeys(rootKey, salt);

            const opened = await openHandshakePayload(
              sealKeys.claimKey,
              handshake.sealedPayload,
            );

            const p = opened as Partial<ClaimPayload>;

            // Invalid claims are ignored, never fatal: transfer tags are
            // public, so aborting here would let anyone deny the transfer. The
            // SPAKE2 transcript already keys the seal to both Nostr identities
            // and this transfer; the echoes below tie it to this exact
            // publication and to the rendezvous we actually sent, so a live-PIN
            // attacker cannot republish our rendezvous with altered fields
            // under its own identity and relay the real receiver's claim to us.
            // The plaintext target is deliberately not trusted here — the
            // sealed transcript hash is what carries authority.
            if (
              p.type === 'claim' &&
              p.transferId === transferId &&
              p.senderNonce === run.nonce &&
              typeof p.receiverNonce === 'string' &&
              p.receiverNonce &&
              p.senderPubkey === publicKey &&
              p.receiverPubkey === event.pubkey &&
              p.transcriptHash === run.transcriptHash &&
              isPinBucketActive(generation.bucket)
            ) {
              verified = {
                receiverPubkey: event.pubkey,
                payload: p as ClaimPayload,
                rootKey,
                confirmKey: sealKeys.confirmKey,
              };
            }
          } catch {
            // Wrong PIN or invalid element: fall through to replacement.
          }

          if (settled || isCancelled()) return;
          if (verified) {
            settled = true;
            cleanup();
            // First-claim lockout: rotation has stopped, and the retained
            // generations and their PAKE secrets go with it. The PIN is no
            // longer anything anyone can use.
            retireGenerations(() => false);
            resolve(verified);
            return;
          }

          // The failed claim consumed this generation's element; publish a
          // replacement so the generation stays claimable.
          try {
            await publishReplacement(generation);
          } catch (err) {
            console.error('Failed to publish replacement rendezvous:', err);
          }
        })();
      },
    );
  });
  // Nothing may be awaiting this when close() rejects it.
  void claimed.catch(() => {});

  const scheduleRotation = () => {
    if (rotationInterval) clearInterval(rotationInterval);
    rotationInterval = setInterval(() => {
      if (settled || isCancelled()) return;
      void (async () => {
        try {
          await publishRendezvous();
        } catch (err) {
          console.error('Failed to publish rendezvous rotation:', err);
        }
      })();
    }, PIN_ROTATION_MS);
  };

  // First PIN generation, then rotate.
  void (async () => {
    try {
      await publishRendezvous();
    } catch (err) {
      giveUp(err instanceof Error ? err : new Error('Publish failed'));
    }
  })();
  scheduleRotation();

  let refreshInFlight = false;

  return {
    transferId,
    salt,
    secretKey,
    publicKey,
    claimed,
    // On-demand PIN reset: drop every retained generation so previously shown
    // PINs stop authenticating, restart the rotation cadence, and publish a
    // fresh rendezvous — reusing the transfer's file bytes, keys, and relay
    // connections.
    async refresh() {
      if (settled || isCancelled() || refreshInFlight) return;
      refreshInFlight = true;
      try {
        pinEpoch += 1;
        retireGenerations(() => false);
        scheduleRotation();
        await publishRendezvous();
      } catch (err) {
        console.error('Failed to publish refreshed PIN:', err);
      } finally {
        refreshInFlight = false;
      }
    },
    close() {
      giveUp(new Error('Cancelled'));
      // Wiping is idempotent, so this is a no-op on the claim path and the
      // cleanup on every other exit.
      retireGenerations(() => false);
    },
  };
}

/**
 * What the locked session owes each side: the code the operator must be told,
 * and the key that seals the Code Exchange codes this session carries.
 */
export interface PinSenderSession {
  /**
   * The confirmation code the receiver is showing. Never displayed on this
   * side: the sender's operator must learn it from their intended receiver
   * over a channel an attacker who stole the PIN does not control, and showing
   * it here would defeat the entire mechanism.
   */
  expectedCode: string;
  /** Seals the offer this session carries, and the answer that comes back. */
  signalsKey: CryptoKey;
}

/**
 * Answer a verified claim: publish the sealed confirm that delivers the file
 * metadata and proves this side ran the same PAKE, and derive what the code
 * gate and the carried offer need.
 *
 * The confirm goes out *before* the code gate — the receiver needs it to learn
 * what is being offered and to display the confirmation code at all. The gate
 * guards the connection offer and the file bytes, which is where the actual
 * harm lives.
 */
export async function confirmPinClaim(options: {
  client: NostrClient;
  rendezvous: PinRendezvous;
  claim: VerifiedClaim;
  metadata: TransferMetadata;
}): Promise<PinSenderSession> {
  const { client, rendezvous, claim, metadata } = options;
  const { transferId, salt, secretKey, publicKey } = rendezvous;

  // The session's signals key is an HKDF derivation off the SPAKE2 root the
  // claim just proved agreement on. It seals the codes this session carries,
  // which is what authenticates them.
  const { signals: signalsKey } = await derivePinSessionKeys(
    claim.rootKey,
    salt,
  );

  const metadataHash = await computeTransferMetadataHash(metadata);

  // The claim proves whoever sent it knew a live PIN. That is exactly the
  // thing a shoulder-surfer or a screen-share viewer also knows, and the lock
  // hands the transfer to whoever got here first. So stop: no offer, and no
  // file byte, leaves this device until a human vouches that the peer we
  // locked onto is the peer they meant. This code proves possession of the
  // locked session — a front-runner that won the race holds that session and
  // can compute it — but the operator learns it from their intended receiver
  // over a channel the attacker does not control, and that receiver has no
  // code to give when a front-runner holds the lock.
  //
  // Note what this deliberately does not do: the front-runner still holds the
  // lock, so it can stall this transfer. Stopping that is out of scope —
  // availability is a non-goal system-wide, not just here (see
  // docs/ARCHITECTURE.md, "Availability Is a Non-Goal"). Not leaking the file
  // is the property worth defending; uninterruptible delivery is not one this
  // architecture can offer in the first place.
  const expectedCode = await deriveConfirmationCode(claim.rootKey, salt, {
    transferId,
    senderNonce: claim.payload.senderNonce,
    receiverNonce: claim.payload.receiverNonce,
    transcriptHash: claim.payload.transcriptHash,
    metadataHash,
  });

  const confirmPayload: ConfirmPayload = {
    type: 'confirm',
    transferId,
    senderNonce: claim.payload.senderNonce,
    receiverNonce: claim.payload.receiverNonce,
    senderPubkey: publicKey,
    receiverPubkey: claim.receiverPubkey,
    transcriptHash: claim.payload.transcriptHash,
    metadata,
  };
  await client.publish(
    createHandshakeEvent(
      secretKey,
      claim.receiverPubkey,
      transferId,
      'confirm',
      await sealHandshakePayload(claim.confirmKey, confirmPayload),
    ),
  );

  return { expectedCode, signalsKey };
}

/**
 * Whether what the operator typed is the code the receiver is showing.
 *
 * Typed by a person from something read aloud, so the spelling is forgiven the
 * way the alphabet allows — case, the letters it treats as digits, and the
 * spacing anyone adds to eight characters — and then compared without a timing
 * signal.
 */
export function confirmationCodeMatches(
  typed: string,
  expected: string,
): boolean {
  return constantTimeEqual(normalizeCrockfordBase32(typed), expected);
}
