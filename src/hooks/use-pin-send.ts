import type { Event } from 'nostr-tools';
import { useCallback, useMemo, useRef, useState } from 'react';
import { hangUp } from '@/lib/code-exchange/hang-up';
import {
  completeSend,
  createSenderOffer,
  readAnswer,
  type SenderFallback,
  type SendFallbackKind,
  startSenderFallback,
} from '@/lib/code-exchange/send';
import {
  describeSendSource,
  torFallbackRefusal,
} from '@/lib/code-exchange/source';
import { createTorProgress } from '@/lib/code-exchange/tor-progress';
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
import type { DuplexChannel } from '@/lib/duplex-channel';
import { P2PConnectionError } from '@/lib/errors';
import {
  ANONYMOUS_SIGNALING_RELAYS,
  type ClaimPayload,
  type ConfirmPayload,
  type ContentType,
  carryOfferForAnswer,
  computeRendezvousTranscriptHash,
  computeTransferMetadataHash,
  createHandshakeEvent,
  createNostrClient,
  createRendezvousEvent,
  DEFAULT_RELAYS,
  EVENT_KIND_DATA_TRANSFER,
  generateEphemeralKeys,
  generateHandshakeNonce,
  type NostrClient,
  openHandshakePayload,
  parseHandshakeEvent,
  type RendezvousPayload,
  sealHandshakePayload,
  type TransferState,
  uint8ArrayToBase64,
} from '@/lib/nostr';
import { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';
import type { TorBridge } from '@/lib/tor/bridge';
import type { TransferSource } from '@/lib/transfer-source';
import type { WebRTCConnection } from '@/lib/webrtc';

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
interface VerifiedClaim {
  receiverPubkey: string;
  payload: ClaimPayload;
  /** Non-extractable HKDF root of the matching SPAKE2 session. */
  rootKey: CryptoKey;
  /** Seal key for the confirm this sender now owes the receiver. */
  confirmKey: CryptoKey;
}

/**
 * Time the sender waits for its operator to type the receiver's confirmation
 * code before giving up on the locked claim.
 *
 * Shorter than the receiver's offer wait, so this sender-side deadline
 * normally expires first when no matching code is entered.
 */
const CONFIRM_CODE_ENTRY_TIMEOUT_MS = 150000;

/**
 * Time the sender waits for the receiver's answer once its offer is out. No
 * human is in this leg: the receiver answers as soon as it has built one,
 * which takes a few seconds of candidate gathering.
 */
const ANSWER_WAIT_TIMEOUT_MS = 60000;

/**
 * How often the offer is republished while no answer has come back, so a
 * relay that missed it does not strand the session.
 */
const OFFER_RETRY_MS = 5000;

/**
 * What the sender chose on the send tab, beyond the files themselves.
 *
 * `anonymous` decides the whole mode at once: the PIN is minted at the
 * anonymous length, signaling is carried to the onion relay pool through Tor,
 * and the offer asks for the Tor fallback rather than the clearnet one. None
 * of these can disagree — the receiver reads the mode off the PIN's length,
 * so a PIN of one kind published on the other pool would simply never be
 * found, and a clearnet fallback would hand both devices' addresses to the
 * very relays the mode keeps them from.
 */
export interface PinSendOptions {
  /** Route this transfer's signaling, and its fallback, through Tor. */
  anonymous: boolean;
  /** Which Snowflake bridge to reach Tor through. Ignored when not anonymous. */
  bridge: TorBridge;
}

export interface UsePinSendReturn {
  state: TransferState;
  pin: string | null;
  send: (content: TransferSource, options: PinSendOptions) => Promise<void>;
  cancel: () => void;
  /**
   * Mint and publish a fresh PIN immediately, invalidating every previously
   * shown PIN, without redoing file read / key generation / relay connection.
   * No-op unless a transfer is waiting for a receiver.
   */
  refreshPin: () => Promise<void>;
  /**
   * Submit the confirmation code the receiver read out. Returns whether it
   * matched; a mismatch leaves the transfer parked so typos are retryable.
   *
   * Note there is no getter for the expected code. The sender must learn it
   * from the receiver over a channel an attacker who stole the PIN does not
   * control — showing it here would defeat the entire mechanism.
   */
  submitConfirmationCode: (code: string) => boolean;
}

export function usePinSend(): UsePinSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [pin, setPin] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  // Distinguishes invocations; see the note where a run claims one.
  const runIdRef = useRef(0);
  // Closes everything the current run holds open: its relay client, the Tor
  // client behind an anonymous transfer, the fallback's relay pool and
  // sweep, and the peer connection. Set by the run, called by cancel.
  const releaseRef = useRef<(() => void) | null>(null);
  // Set while a transfer is waiting for a receiver; null otherwise.
  const refreshPinRef = useRef<(() => Promise<void>) | null>(null);
  // Both set only while the send is parked on the confirmation code: the value
  // to match, and the resolver that releases the gate once it does. Kept in
  // refs rather than state so the expected code never reaches a render tree.
  const expectedConfirmationCodeRef = useRef<string | null>(null);
  const confirmationCodeAcceptRef = useRef<(() => void) | null>(null);

  const refreshPin = useCallback(async () => {
    await refreshPinRef.current?.();
  }, []);

  const submitConfirmationCode = useCallback((code: string): boolean => {
    const expected = expectedConfirmationCodeRef.current;
    if (!expected) return false;
    if (!constantTimeEqual(normalizeCrockfordBase32(code), expected)) {
      return false;
    }
    confirmationCodeAcceptRef.current?.();
    return true;
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    sendingRef.current = false;
    refreshPinRef.current = null;
    expectedConfirmationCodeRef.current = null;
    confirmationCodeAcceptRef.current = null;
    releaseRef.current?.();
    releaseRef.current = null;
    setPin(null);
    setState({ status: 'idle' });
  }, []);

  const send = useCallback(
    async (content: TransferSource, options: PinSendOptions) => {
      // Guard against concurrent invocations
      if (sendingRef.current) return;
      sendingRef.current = true;
      cancelledRef.current = false;
      // Each invocation owns this hook's shared refs only until the next one
      // starts. That used to be close to academic — connecting took seconds —
      // but an anonymous transfer can sit inside a five-minute Tor bootstrap,
      // which is long enough for the user to cancel and start another one
      // underneath it. `cancel()` clears the guard the next run checks, so the
      // superseded run wakes into a hook that is no longer its own: its
      // `cancelledRef` read comes back false because the new run reset it, and
      // its cleanup would report state and close a client that now belong to
      // the replacement. A run id is what tells the two apart.
      const runId = ++runIdRef.current;
      const superseded = () => runIdRef.current !== runId;
      const abandoned = () => cancelledRef.current || superseded();

      // What this run holds open, closed by this run whoever owns the ref by
      // then — and by cancel, which reaches it through releaseRef.
      let client: NostrClient | null = null;
      let transport: AnonymousSignalingTransport | null = null;
      let fallback: SenderFallback | null = null;
      let rtc: WebRTCConnection | null = null;
      let channel: DuplexChannel | null = null;
      // A cancel tells a receiver mid-transfer why the connection is going
      // away; any other exit has already said what happened.
      const release = (cancelling = false) => {
        if (cancelling) hangUp(rtc, channel);
        else rtc?.close();
        rtc = null;
        channel = null;
        fallback?.close();
        fallback = null;
        client?.close();
        client = null;
        transport?.close();
        transport = null;
      };
      const cancelRelease = () => release(true);
      releaseRef.current = cancelRelease;

      const contentType: ContentType = 'file';
      // The PIN's length is what tells the receiver which pool to look on, so
      // the kind and the relay set are decided together and never separately.
      const pinKind: PinKind = options.anonymous ? 'anonymous' : 'standard';
      const relays = options.anonymous
        ? ANONYMOUS_SIGNALING_RELAYS
        : DEFAULT_RELAYS;

      // Retained PIN generations. Declared outside the try so the finally block
      // can wipe any PAKE secrets left behind by an exceptional exit (cancel,
      // wait timeout, publish failure) that skipped the post-claim retirement.
      const generations: PinGeneration[] = [];

      try {
        const described = describeSendSource(content);
        if ('error' in described) {
          setState({ status: 'error', message: described.error });
          return;
        }
        const { metadata } = described;
        const { fileName, fileSize, mimeType } = metadata;
        const fileMetadata = { fileName, fileSize, mimeType };

        // Per-transfer credentials for the handshake: public salt (HKDF input
        // for the session keys) and an ephemeral Nostr identity. The PIN
        // authenticates the SPAKE2 run; the content key comes later, out of
        // the Code Exchange agreement the handshake then carries.
        const salt = generateSalt();
        const { secretKey, publicKey } = generateEphemeralKeys();
        const transferId = generateTransferId();

        if (abandoned()) return;

        // One Tor client for the whole anonymous transfer: its relay sockets
        // carry the handshake, and if no direct route opens, the Tor fallback
        // publishes its onion service on it too. Two would mean two
        // bootstraps, minutes each.
        const torProgress = createTorProgress();
        // While the handshake's relay sockets wait on the bootstrap, its
        // progress is the page's.
        let bootstrapOnScreen = true;
        if (options.anonymous) {
          transport = new AnonymousSignalingTransport({
            bridge: options.bridge,
            onStatus: (message) => {
              torProgress.push(message);
              if (bootstrapOnScreen && !abandoned()) {
                setState({ status: 'connecting', message });
              }
            },
          });
        }

        // The fallback, prepared from the start rather than once a receiver
        // has turned up. Proving the relays the offer will name, preparing the
        // storage ring and sweeping the relay population behind it take as
        // long as they take, and the PIN on screen is a wait of its own they
        // run behind — so by the time a receiver has claimed and confirmed,
        // the offer's relays are proven and the ring is ready. An anonymous
        // transfer's fallback is the Tor one, unless the selection is more
        // than it can carry; then it has none, and a dead direct route ends
        // the transfer.
        const fallbackKind: SendFallbackKind = options.anonymous
          ? torFallbackRefusal(content)
            ? 'none'
            : 'anonymous'
          : 'relay';
        fallback = startSenderFallback({
          kind: fallbackKind,
          transport,
          isCancelled: abandoned,
        });
        const preparedFallback = fallback;

        // Create Nostr client for signaling
        setState({
          status: 'connecting',
          message: options.anonymous
            ? 'Starting the Tor client for anonymous signaling...'
            : 'Connecting to relays...',
        });
        client = createNostrClient(
          [...relays],
          transport ? { anonymousTransport: transport } : {},
        );
        const nostr = client;
        if (options.anonymous) {
          await nostr.waitForAnonymousTransport();
          bootstrapOnScreen = false;
          if (abandoned()) return;
          setState({
            status: 'connecting',
            message: 'Tor is up. Opening onion relay connections...',
          });
        }
        await nostr.waitForConnection();

        if (abandoned()) return;

        setState({
          status: 'waiting_for_receiver',
          message: 'Waiting for receiver...',
          contentType,
          fileMetadata,
          useWebRTC: true,
          currentRelays: nostr.getRelays(),
          totalRelays: relays.length,
        });

        // Rotate the PIN until a receiver proves knowledge of one of the
        // retained generations, then lock the transfer to that receiver. A
        // manual refresh bumps the epoch, so an in-flight rotation publish from
        // before the reset can neither register its generation nor be displayed.
        let pinEpoch = 0;

        // Best-effort cleanup for generations leaving the retained list: their
        // PAKE secret dies with them. The bigint ephemeral scalar cannot be
        // wiped and is simply dropped.
        const retireGenerations = (keep: (g: PinGeneration) => boolean) => {
          const kept = generations.filter(keep);
          for (const generation of generations) {
            if (!kept.includes(generation)) {
              wipeBufferSource(generation.pakeSecret);
            }
          }
          generations.splice(0, generations.length, ...kept);
        };

        // Start a fresh single-use SPAKE2 run and build the rendezvous event
        // that publishes its element. The element is blinded, and nothing here
        // may be PIN-testable offline. File metadata stays out and is delivered
        // inside the sealed confirm after the handshake. The transcript hash
        // covers what we are about to publish, so a claim can be checked against
        // the rendezvous we actually sent rather than the one the claimant says
        // it saw — fresh per publication, since the nonce and element are.
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
          const transcriptHash = await computeRendezvousTranscriptHash(
            payload,
            salt,
          );
          const event = createRendezvousEvent(
            secretKey,
            payload,
            salt,
            hint,
            bucket,
          );
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
          // Until the generation is registered below, this scope owns the
          // secret: wipe it on every exit — stale epoch, cancellation, or a
          // throw anywhere between derivation and registration.
          let registered = false;
          try {
            const { run, event } = await startRun(pakeSecret, hint, bucket);

            if (abandoned() || epoch !== pinEpoch) return;

            // Register the generation before publishing so a fast claim can
            // never race ahead of the retained-keys list.
            generations.unshift({
              pakeSecret,
              bucket,
              hint,
              run,
              verifyBudget: CLAIM_VERIFY_LIMIT,
            });
            registered = true;
            retireGenerations((generation) =>
              isPinBucketActive(generation.bucket),
            );

            await nostr.publish(event);

            if (!abandoned() && epoch === pinEpoch) {
              setPin(newPin);
            }
          } finally {
            if (!registered) wipeBufferSource(pakeSecret);
          }
        };

        // Replace a consumed element: same PIN, same bucket and hint, fresh
        // ephemeral scalar behind a fresh blinded element. Published after every
        // failed claim verification so the generation stays claimable — the
        // honest receiver that lost the race to a junk claim re-claims against
        // this replacement. Skipped once the budget is exhausted or the bucket
        // has expired, which is what stalls a flooded generation.
        const publishReplacement = async (generation: PinGeneration) => {
          const epoch = pinEpoch;
          if (
            generation.verifyBudget <= 0 ||
            !isPinBucketActive(generation.bucket)
          ) {
            return;
          }
          const { run, event } = await startRun(
            generation.pakeSecret,
            generation.hint,
            generation.bucket,
          );
          if (
            abandoned() ||
            epoch !== pinEpoch ||
            !generations.includes(generation)
          ) {
            return;
          }
          // Assign before publishing, mirroring the fresh-PIN path: a receiver
          // can re-claim the moment any relay accepts the event, potentially
          // before publish() resolves here — and publish() rejecting does not
          // mean no relay accepted, so the run is retained even then. An
          // element that truly never left is merely inert: no claim can name
          // its transcript hash, and rotation replaces the generation anyway.
          generation.run = run;
          await nostr.publish(event);
        };

        const claim = await new Promise<VerifiedClaim>((resolve, reject) => {
          let settled = false;
          let rotationInterval: ReturnType<typeof setInterval> | null = null;
          let cancelPoll: ReturnType<typeof setInterval> | null = null;
          let timeout: ReturnType<typeof setTimeout> | null = null;
          let subId: string | null = null;

          const cleanup = () => {
            if (rotationInterval) clearInterval(rotationInterval);
            if (cancelPoll) clearInterval(cancelPoll);
            if (timeout) clearTimeout(timeout);
            if (subId) nostr.unsubscribe(subId);
            rotationInterval = null;
            cancelPoll = null;
            timeout = null;
            subId = null;
            // Settling ends this transfer's rotation era: bump the epoch so an
            // in-flight publishRendezvous wakes up stale and aborts instead of
            // registering a generation, publishing after lockout, or
            // re-displaying a PIN.
            pinEpoch += 1;
            refreshPinRef.current = null;
          };

          timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(
              new Error('No receiver connected. Please start a new transfer.'),
            );
          }, PIN_WAIT_TIMEOUT_MS);

          cancelPoll = setInterval(() => {
            if (abandoned() && !settled) {
              settled = true;
              cleanup();
              reject(new Error('Cancelled'));
            }
          }, 250);

          const processedEventIds = new Set<string>();

          subId = nostr.subscribe(
            [
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': [transferId],
                '#p': [publicKey],
              },
            ],
            (event: Event) => {
              if (settled || abandoned()) return;
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

              // Route by the claim's plaintext target: it names the exact
              // published element the claim was derived against, so a claim
              // whose target is spent, expired, or was never ours costs
              // nothing. A retained generation has no authority outside the
              // sender's current and immediately previous wall-clock buckets,
              // and each one runs at most CLAIM_VERIFY_LIMIT verifications —
              // every attempt is one online PIN guess for the claim's author,
              // and this counter is the only thing bounding those guesses.
              const generation = generations.find(
                (candidate) =>
                  isPinBucketActive(candidate.bucket) &&
                  candidate.verifyBudget > 0 &&
                  candidate.run?.transcriptHash === handshake.target,
              );
              const run = generation?.run;
              if (!generation || !run) return;
              // Consume the run before any await: the element is single-use,
              // and a concurrent claim naming the same target must find it
              // already spent, never finish the same scalar twice.
              generation.run = null;
              generation.verifyBudget -= 1;

              void (async () => {
                // Finish our side of the SPAKE2 run against the claimant's
                // element, then try the claim seal. A wrong PIN lands on a
                // different root key and the seal simply refuses to open.
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
                  // public, so aborting here would let anyone deny the
                  // transfer. The SPAKE2 transcript already keys the seal to
                  // both Nostr identities and this transfer; the echoes below
                  // tie it to this exact publication and to the rendezvous we
                  // actually sent, so a live-PIN attacker cannot republish our
                  // rendezvous with altered fields under its own identity and
                  // relay the real receiver's claim to us. The plaintext
                  // target is deliberately not trusted here — the sealed
                  // transcript hash is what carries authority.
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

                if (settled || abandoned()) return;
                if (verified) {
                  settled = true;
                  cleanup();
                  resolve(verified);
                  return;
                }

                // The failed claim consumed this generation's element; publish
                // a replacement so the generation stays claimable.
                try {
                  await publishReplacement(generation);
                } catch (err) {
                  console.error(
                    'Failed to publish replacement rendezvous:',
                    err,
                  );
                }
              })();
            },
          );

          const scheduleRotation = () => {
            if (rotationInterval) clearInterval(rotationInterval);
            rotationInterval = setInterval(() => {
              if (settled || abandoned()) return;
              void (async () => {
                try {
                  await publishRendezvous();
                } catch (err) {
                  console.error('Failed to publish rendezvous rotation:', err);
                }
              })();
            }, PIN_ROTATION_MS);
          };

          // On-demand PIN reset: drop every retained generation so previously
          // shown PINs stop authenticating, restart the rotation cadence, and
          // publish a fresh rendezvous — reusing the transfer's file bytes,
          // keys, and relay connections.
          let refreshInFlight = false;
          refreshPinRef.current = async () => {
            if (settled || abandoned() || refreshInFlight) return;
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
          };

          // First PIN generation, then rotate.
          void (async () => {
            try {
              await publishRendezvous();
            } catch (err) {
              if (settled) return;
              settled = true;
              cleanup();
              reject(err instanceof Error ? err : new Error('Publish failed'));
            }
          })();
          scheduleRotation();
        });

        if (abandoned()) return;

        // First-claim lockout: rotation has stopped, the retained generations
        // and their PAKE secrets are wiped, and only this receiver's events are
        // processed from here on. The PIN is no longer needed for display.
        setPin(null);
        retireGenerations(() => false);

        // The session's signals key is an HKDF derivation off the SPAKE2 root
        // the claim just proved agreement on. It seals the codes this session
        // carries, which is what authenticates them.
        const { signals: signalsKey } = await derivePinSessionKeys(
          claim.rootKey,
          salt,
        );

        const metadataHash = await computeTransferMetadataHash(metadata);

        // The claim proves whoever sent it knew a live PIN. That is exactly the
        // thing a shoulder-surfer or a screen-share viewer also knows, and the
        // lock above hands the transfer to whoever got here first. So stop: no
        // offer, and no file byte, leaves this device until a human vouches
        // that the peer we locked onto is the peer they meant. The code below
        // proves possession of the locked session — a front-runner that won
        // the race holds that session and can compute it — but the operator
        // learns it from their intended receiver over a channel the attacker
        // does not control, and that receiver has no code to give when a
        // front-runner holds the lock.
        //
        // Note what this deliberately does not do: the front-runner still holds
        // the lock, so it can stall this transfer. Stopping that is out of scope
        // — availability is a non-goal system-wide, not just here (see
        // docs/ARCHITECTURE.md, "Availability Is a Non-Goal"). Not leaking the
        // file is the property worth defending; uninterruptible delivery is not
        // one this architecture can offer in the first place.
        const expectedCode = await deriveConfirmationCode(claim.rootKey, salt, {
          transferId,
          senderNonce: claim.payload.senderNonce,
          receiverNonce: claim.payload.receiverNonce,
          transcriptHash: claim.payload.transcriptHash,
          metadataHash,
        });

        if (abandoned()) return;

        // The offer is built while the operator types the code. It is
        // published only past the gate below, but gathering its candidates and
        // waiting on the fallback's relays need no human, so they need not
        // wait for one either.
        let offerOnScreen = false;
        const offerBuild = createSenderOffer({
          metadata,
          fallback: preparedFallback,
          isCancelled: abandoned,
          report: (update) => {
            if (offerOnScreen && !abandoned()) setState(update);
          },
          onConnection: (connection) => {
            rtc = connection;
          },
        });
        // Awaited only past the gate; a failure before then must not surface
        // as an unhandled rejection in the meantime.
        offerBuild.catch(() => undefined);

        // Mutual proof plus metadata delivery: the confirm is sealed under the
        // session's confirm key, which only the matching PAKE peer holds, so
        // publishing it is this side's PIN proof in the reverse direction. It
        // goes out *before* the code gate — the receiver needs it to learn what
        // is being offered and to display the confirmation code at all. The
        // code gate guards the connection offer and the file bytes, which is
        // where the actual harm lives.
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
        const confirmEvent = createHandshakeEvent(
          secretKey,
          claim.receiverPubkey,
          transferId,
          'confirm',
          await sealHandshakePayload(claim.confirmKey, confirmPayload),
        );
        await nostr.publish(confirmEvent);

        if (abandoned()) return;

        setState((prevState) => ({
          ...prevState,
          status: 'awaiting_confirmation_code',
          message:
            'Ask your receiver for the confirmation code shown on their screen.',
        }));

        expectedConfirmationCodeRef.current = expectedCode;
        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            let cancelPoll: ReturnType<typeof setInterval> | null = null;
            let timeout: ReturnType<typeof setTimeout> | null = null;

            const cleanup = () => {
              if (cancelPoll) clearInterval(cancelPoll);
              if (timeout) clearTimeout(timeout);
              cancelPoll = null;
              timeout = null;
              confirmationCodeAcceptRef.current = null;
            };

            timeout = setTimeout(() => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(
                new Error(
                  'Confirmation code was not entered in time. Start a new transfer.',
                ),
              );
            }, CONFIRM_CODE_ENTRY_TIMEOUT_MS);

            cancelPoll = setInterval(() => {
              if (abandoned() && !settled) {
                settled = true;
                cleanup();
                reject(new Error('Cancelled'));
              }
            }, 250);

            // Only a match calls this. A wrong code never settles the promise, so
            // a typo costs a retry rather than the transfer.
            confirmationCodeAcceptRef.current = () => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve();
            };
          });
        } finally {
          expectedConfirmationCodeRef.current = null;
          confirmationCodeAcceptRef.current = null;
        }

        if (abandoned()) return;

        // The typed code matched: the human vouched for the peer we locked
        // onto, so the gate opens. From here this is a Code Exchange session
        // whose codes ride the sealed channel instead of a person's hand.
        offerOnScreen = true;
        setState({
          status: 'connecting',
          message: 'Preparing the connection...',
          contentType,
          fileMetadata,
        });
        const offer = await offerBuild;
        if (!offer || abandoned()) return;
        void (async () => {
          const opened = await offer.channelOpened;
          if (rtc === offer.rtc) channel = opened;
        })();

        setState({
          status: 'connecting',
          message: 'Sending the connection offer...',
          contentType,
          fileMetadata,
        });
        const answerCode = await carryOfferForAnswer({
          client: nostr,
          secretKey,
          transferId,
          senderPubkey: publicKey,
          receiverPubkey: claim.receiverPubkey,
          signalsKey,
          isCancelled: abandoned,
          offer: offer.offerBinary,
          retryMs: OFFER_RETRY_MS,
          timeoutMs: ANSWER_WAIT_TIMEOUT_MS,
        });
        if (abandoned()) return;

        // Only the locked receiver can have sealed this, and the confirmation
        // tag inside it still has to bind it to this offer before anything in
        // it is acted on.
        await completeSend({
          offer,
          answer: readAnswer(answerCode),
          content,
          metadata,
          fallback: preparedFallback,
          torProgress: transport ? torProgress : null,
          isCancelled: abandoned,
          report: (update) => {
            if (!abandoned()) setState(update);
          },
          answerMismatchMessage:
            "The receiver's response does not match this transfer. Start a new transfer.",
        });
      } catch (error) {
        if (!abandoned()) {
          setPin(null);
          setState((prevState) => ({
            ...prevState,
            status: 'error',
            message: error instanceof Error ? error.message : 'Failed to send',
            connectionFailed: error instanceof P2PConnectionError,
          }));
        }
      } finally {
        // Wiping is idempotent, so this is a no-op on the claim path (which
        // already retired every generation) and the cleanup on every other exit.
        for (const generation of generations) {
          wipeBufferSource(generation.pakeSecret);
        }
        generations.length = 0;
        // These belong to whichever run is current, so only that run may clear
        // them: a superseded run doing it would release the replacement's
        // concurrency guard and drop the code its operator is about to type.
        if (!superseded()) {
          sendingRef.current = false;
          expectedConfirmationCodeRef.current = null;
          confirmationCodeAcceptRef.current = null;
        }
        if (releaseRef.current === cancelRelease) releaseRef.current = null;
        release();
      }
    },
    [],
  );

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, pin, send, cancel, refreshPin, submitConfirmationCode }),
    [state, pin, send, cancel, refreshPin, submitConfirmationCode],
  );
}
