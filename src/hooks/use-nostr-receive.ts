import type { Event } from 'nostr-tools';
import { useCallback, useRef, useState } from 'react';
import {
  computePinHintFromLocator,
  decrypt,
  deriveConfirmationCode,
  deriveHandshakeSealKeys,
  deriveNostrSessionKeys,
  encrypt,
  finishPake,
  getPinBucket,
  isValidPakeMessage,
  MAX_CLAIM_ATTEMPTS,
  MAX_CLAIM_CANDIDATES,
  MAX_MESSAGE_SIZE,
  type NostrSessionKeys,
  PIN_HINT_LOOKBACK_BUCKETS,
  PIN_TTL_MS,
  startPake,
  wipeBufferSource,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import {
  base64ToUint8Array,
  type ClaimPayload,
  type ConfirmPayload,
  computeRendezvousTranscriptHash,
  computeTransferMetadataHash,
  createHandshakeEvent,
  createNostrClient,
  createSignalingEvent,
  DEFAULT_RELAYS,
  EVENT_KIND_DATA_TRANSFER,
  EVENT_KIND_RENDEZVOUS,
  generateEphemeralKeys,
  generateHandshakeNonce,
  type NostrClient,
  openHandshakePayload,
  parseHandshakeEvent,
  parseRendezvousEvent,
  parseSignalingEvent,
  type RendezvousPayload,
  sealHandshakePayload,
  type TransferMetadata,
  type TransferState,
} from '@/lib/nostr';
import { ACK, createDataChannelReceiver } from '@/lib/p2p-transfer';
import {
  type AppendSink,
  createAdaptiveAppendSink,
  createReceiveSink,
  type ReceiveSink,
} from '@/lib/scratch-sink';
import type { PinKeyMaterial, ReceivedContent } from '@/lib/types';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';

/**
 * Time to establish the WebRTC data channel once signaling has started.
 * Bounds the post-offer phase, which the per-transfer stall watchdog does not
 * cover (it only arms once the channel opens). Mirrors the sender's timeout.
 */
const P2P_CONNECTION_TIMEOUT_MS = 30000;

/**
 * Time to wait for the sender's confirm after publishing the claims. The
 * sender confirms as soon as a claim verifies — no human is in this leg — so
 * this only needs to cover relay latency. It is also the window in which a
 * mistyped-but-checksum-valid PIN surfaces: such a claim is silently ignored
 * by the sender, and this timeout is the only signal the receiver gets.
 */
const CONFIRM_TIMEOUT_MS = 60000;

/**
 * Time to wait for the sender's first WebRTC signal after its confirm.
 *
 * Generous because a human is in the loop here: the sender publishes nothing
 * past the confirm until its operator types the confirmation code this side
 * is displaying. The budget has to cover reading eight characters aloud over
 * a phone call and someone typing them back.
 *
 * The sender's own entry deadline is deliberately shorter than this window, so
 * a slow typist makes the sender report the timeout rather than this side
 * giving up on an offer that is still coming.
 */
const OFFER_WAIT_TIMEOUT_MS = 180000;

/**
 * How long to keep the peer connection alive after sending the final ACK.
 * The sender closes the connection as soon as the ACK arrives; this delayed
 * close is only a fallback for a sender that never does. Closing in the same
 * tick as the send can tear the transport down before the ACK datagram is
 * delivered, making the sender report "data channel closed before
 * acknowledgment" even though the transfer succeeded.
 */
const ACK_LINGER_MS = 3000;

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

export interface UseNostrReceiveReturn {
  state: TransferState;
  receivedContent: ReceivedContent | null;
  /**
   * The confirmation code to read aloud to the sender, available from the
   * moment the rendezvous payload opens until the sender's confirm arrives.
   */
  confirmationCode: string | null;
  receive: (pinMaterial: PinKeyMaterial) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useNostrReceive(): UseNostrReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [receivedContent, setReceivedContent] =
    useState<ReceivedContent | null>(null);
  const [confirmationCode, setConfirmationCode] = useState<string | null>(null);

  const clientRef = useRef<NostrClient | null>(null);
  const cancelledRef = useRef(false);
  const receivingRef = useRef(false);
  // Storage backing the in-flight or completed transfer. Discarded whenever
  // the payload it backs is abandoned; kept after completion because
  // receivedContent.data reads from it until reset.
  const sinkRef = useRef<ReceiveSink | AppendSink | null>(null);

  const discardSink = useCallback(() => {
    const sink = sinkRef.current;
    sinkRef.current = null;
    if (sink) void sink.discard();
  }, []);

  const cancel = useCallback(() => {
    // Only an in-flight transfer's storage is abandoned by cancel; a completed
    // payload stays readable until reset.
    if (receivingRef.current) discardSink();
    cancelledRef.current = true;
    receivingRef.current = false;
    setConfirmationCode(null);
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    setState({ status: 'idle' });
  }, [discardSink]);

  const reset = useCallback(() => {
    cancel();
    discardSink();
    setReceivedContent(null);
  }, [cancel, discardSink]);

  const receive = useCallback(
    async (pinMaterial: PinKeyMaterial) => {
      // Guard against concurrent invocations
      if (receivingRef.current) return;
      receivingRef.current = true;
      cancelledRef.current = false;
      setReceivedContent(null);
      setConfirmationCode(null);
      // The previous transfer's payload (if any) is gone from the UI now.
      discardSink();

      try {
        if (
          !pinMaterial.pakeSecret ||
          pinMaterial.pakeSecret.length === 0 ||
          !pinMaterial.locator
        ) {
          setState({
            status: 'error',
            message: 'PIN unavailable. Please re-enter.',
          });
          receivingRef.current = false;
          return;
        }
        const pakeSecret = pinMaterial.pakeSecret;

        setState({
          status: 'connecting',
          message: 'Deriving lookup keys...',
        });

        // Mirror the sender's acceptance rule by deriving the receiver's
        // current and immediately previous rotation buckets. Nothing here
        // waits on a key stretch — with the PAKE there is none.
        const currentBucket = getPinBucket();
        const hints = await Promise.all(
          Array.from({ length: PIN_HINT_LOOKBACK_BUCKETS + 1 }, (_, offset) =>
            computePinHintFromLocator(
              pinMaterial.locator,
              currentBucket - offset,
            ),
          ),
        );

        if (cancelledRef.current) return;

        // Connect to relays
        setState({ status: 'connecting', message: 'Connecting to relays...' });
        const client = createNostrClient([...DEFAULT_RELAYS]);
        clientRef.current = client;

        if (cancelledRef.current) return;

        // Search for the rendezvous event
        setState({ status: 'receiving', message: 'Searching for sender...' });

        // The hint is derived from the PIN's public locator segment, so it
        // carries only ~17.3 bits and unrelated transfers sharing a bucket do
        // collide. The rendezvous is plaintext, so nothing here can tell
        // which candidate is our sender — the loop below claims several and
        // lets the handshake decide, but a tight limit could truncate the
        // real event away before it gets there.
        //
        // A flood of forged events sharing the tag can still push the real one
        // out of this page. That is a stall, not a compromise — a forged
        // candidate's confirm can never open under our session keys, so
        // truncation ends in "no transfer found" or a confirm timeout, never
        // in the wrong event being accepted. Paginating instead would not
        // fix it: whoever can forge 50 events can forge 50,000, and chasing
        // pages would hand an attacker an unbounded loop. See
        // docs/ARCHITECTURE.md, "Availability Is a Non-Goal".
        const events = await client.query([
          {
            kinds: [EVENT_KIND_RENDEZVOUS],
            '#h': hints,
            limit: 50,
          },
        ]);

        if (cancelledRef.current) return;

        if (events.length === 0) {
          setState({
            status: 'error',
            message:
              'No transfer found for this PIN. It may have rotated — check the code currently shown on the sender.',
          });
          return;
        }

        // Collect structurally valid candidates, newest first, one per
        // transfer (the sender's current and previous rotation both match our
        // hints and share a transferId — claim only the newest generation).
        let sawExpiredCandidate = false;
        const sortedEvents = [...events].sort(
          (a, b) => (b.created_at || 0) - (a.created_at || 0),
        );

        interface RendezvousCandidate {
          payload: RendezvousPayload;
          salt: Uint8Array;
          senderPubkey: string;
          pakeMessage: Uint8Array;
        }

        // Structural validation only — with a plaintext rendezvous there is
        // nothing to authenticate yet. The payload must be fresh and name the
        // event's own author and transfer id, so a copied payload republished
        // under another identity is rejected, and the SPAKE2 element must be
        // a valid non-identity curve point. Shared between the initial fetch
        // and replacement events that arrive while waiting for the confirm.
        const parseClaimableRendezvous = (
          event: Event,
        ): RendezvousCandidate | null => {
          if (
            !event.created_at ||
            Date.now() - event.created_at * 1000 > PIN_TTL_MS
          ) {
            return null;
          }
          const parsed = parseRendezvousEvent(event);
          if (!parsed) return null;
          const candidate = parsed.payload as Partial<RendezvousPayload>;
          if (
            candidate.type !== 'rendezvous' ||
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

        for (const event of sortedEvents) {
          if (rendezvousCandidates.size >= MAX_CLAIM_CANDIDATES) break;

          // A rendezvous event is only claimable while the sender still honors
          // its PIN generation.
          if (
            !event.created_at ||
            Date.now() - event.created_at * 1000 > PIN_TTL_MS
          ) {
            sawExpiredCandidate = true;
            continue;
          }

          const candidate = parseClaimableRendezvous(event);
          if (!candidate) continue;
          if (rendezvousCandidates.has(candidate.payload.transferId)) continue;

          rendezvousCandidates.set(candidate.payload.transferId, candidate);
        }

        if (rendezvousCandidates.size === 0) {
          setState({
            status: 'error',
            message: sawExpiredCandidate
              ? 'This PIN has expired. Enter the code currently shown on the sender.'
              : 'No claimable transfer found for this PIN. Check the code currently shown on the sender.',
          });
          return;
        }

        if (cancelledRef.current) return;

        // Claim every candidate: run our side of the SPAKE2 exchange against
        // each one's element and seal a claim under the resulting session's
        // claim key. Opening that seal is the sender's proof we know the PIN.
        // Only the candidate our sender actually published will ever answer
        // with a confirm that opens under its session's confirm key.
        //
        // Each claim hands whoever authored that candidate one online PIN
        // guess — an unavoidable property of any PAKE, bounded here by
        // MAX_CLAIM_CANDIDATES against a 2^46.3 space.
        const { secretKey, publicKey } = generateEphemeralKeys();

        setState({
          status: 'receiving',
          message: 'Waiting for the sender to verify...',
        });

        // Run our side of the PAKE against one candidate's element — fresh
        // ephemeral scalar per claim — and seal a claim under the resulting
        // session's claim key. The transcript hash of the rendezvous we
        // actually acted on rides twice: sealed (the sender compares it with
        // what it published and drops the claim on any difference, so a
        // republished rendezvous with any altered field never reaches the
        // point where the two humans compare codes) and in plaintext as the
        // claim's target, routing the claim to the single-use element it was
        // derived against.
        const buildClaim = async (
          rc: RendezvousCandidate,
        ): Promise<ClaimCandidate | null> => {
          try {
            const { message: ownMessage, secret } = startPake(
              'receiver',
              pakeSecret,
            );
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
        // The password scalar stays live past this point: the sender's
        // elements are single-use, so a claim that lost a race is answered
        // with a replacement rendezvous we must re-derive against. It is
        // wiped as soon as the confirm wait settles.

        if (candidates.length === 0) {
          setState({
            status: 'error',
            message:
              'No claimable transfer found for this PIN. Check the code currently shown on the sender.',
          });
          return;
        }

        if (cancelledRef.current) return;

        // Subscribe for confirms before publishing the claims so the response
        // cannot slip past us. The first confirm that opens under one of our
        // sessions' confirm keys — and echoes everything that session
        // committed to — decides which candidate was real. While waiting,
        // also watch for replacement rendezvous events: the sender's elements
        // are single-use, so if a junk claim spent the element we claimed,
        // the sender publishes a fresh one and our claim must be redone
        // against it.
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
            if (cancelledRef.current && !settled) {
              settled = true;
              cleanup();
              reject(new Error('Cancelled'));
            }
          }, 250);

          const processedEventIds = new Set<string>();

          const processEvent = (event: Event) => {
            if (settled || cancelledRef.current) return;
            if (processedEventIds.has(event.id)) return;
            processedEventIds.add(event.id);

            const handshake = parseHandshakeEvent(event);
            if (!handshake || handshake.type !== 'confirm') return;
            // A re-claim shares its transfer id and author with the claim it
            // replaced, so several claimed candidates can match one confirm —
            // only the session the sender actually verified holds the key that
            // opens it, so every match must be tried, not just the first.
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
                  typeof m.fileSizeExact !== 'boolean'
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

          // Re-claim replacements. Only an event authored by the same key
          // that published a rendezvous we already claimed counts — a forged
          // "replacement" under another identity is just another candidate we
          // never claimed. Each re-claim still hands its author one online
          // PIN guess, so the total is capped: a claimed candidate's author
          // rotating elements at us gets at most MAX_CLAIM_ATTEMPTS guesses
          // per receive attempt, not an unbounded stream.
          let claimAttempts = candidates.length;
          const claimedHashes = new Set(
            candidates.map((c) => c.transcriptHash),
          );
          const processedRendezvousIds = new Set<string>();

          const processReplacement = (event: Event) => {
            if (settled || cancelledRef.current) return;
            if (processedRendezvousIds.has(event.id)) return;
            processedRendezvousIds.add(event.id);

            const rc = parseClaimableRendezvous(event);
            if (!rc) return;
            if (
              !candidates.some(
                (c) =>
                  c.transferId === rc.payload.transferId &&
                  c.senderPubkey === rc.senderPubkey,
              )
            ) {
              return;
            }

            void (async () => {
              const transcriptHash = await computeRendezvousTranscriptHash(
                rc.payload,
                rc.salt,
              );
              if (settled || cancelledRef.current) return;
              if (claimedHashes.has(transcriptHash)) return;
              if (claimAttempts >= MAX_CLAIM_ATTEMPTS) return;
              claimAttempts += 1;
              claimedHashes.add(transcriptHash);

              const claim = await buildClaim(rc);
              if (!claim || settled || cancelledRef.current) return;
              // The confirm subscription and poll already cover this claim:
              // its transfer id and author match the original candidate's.
              candidates.push(claim);
              await client.publish(claim.claimEvent);
            })().catch((err) => {
              console.error('Failed to re-claim replacement rendezvous:', err);
            });
          };

          rendezvousSubId = client.subscribe(
            [
              {
                kinds: [EVENT_KIND_RENDEZVOUS],
                '#h': hints,
              },
            ],
            processReplacement,
          );

          const publishAndPoll = async () => {
            for (const candidate of candidates) {
              await client.publish(candidate.claimEvent);
            }
            // Backstop for relays that processed the publish before the
            // subscription: poll for an already-stored confirm.
            queryPoll = setInterval(() => {
              if (settled || cancelledRef.current) return;
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
                  for (const event of existing) {
                    processEvent(event);
                  }
                } catch (err) {
                  console.error('Failed to query for confirm event:', err);
                }
              })();
            }, 3000);
          };

          void publishAndPoll().catch((err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err instanceof Error ? err : new Error('Publish failed'));
          });
        });

        let winner: Awaited<typeof winnerPromise>;
        try {
          winner = await winnerPromise;
        } finally {
          // The PAKE runs are done, win or lose; the password scalar has no
          // further use once nothing can be re-claimed.
          wipeBufferSource(pakeSecret);
        }

        if (cancelledRef.current) return;

        const { candidate: session, metadata } = winner;
        const transferId = session.transferId;
        const senderPubkey = session.senderPubkey;
        const salt = session.salt;

        const resolvedFileName = metadata.fileName || 'unknown';
        const resolvedFileSize = metadata.fileSize;
        const resolvedFileSizeExact = metadata.fileSizeExact;
        const resolvedMimeType =
          metadata.mimeType || 'application/octet-stream';

        if (resolvedFileSize > MAX_MESSAGE_SIZE) {
          setState({
            status: 'error',
            message: `Transfer rejected: Size (${formatFileSize(resolvedFileSize)}) exceeds limit (${formatFileSize(MAX_MESSAGE_SIZE)})`,
          });
          return;
        }

        // The confirm proved the sender ran our PAKE session, and its sealed
        // metadata is now on the table. The sender publishes nothing further
        // — no WebRTC offer, no file byte — until its operator types this
        // code. Someone who front-ran us with a stolen PIN holds a different
        // SPAKE2 session, so the code on their screen is not the one the
        // sender is about to be told.
        const metadataHash = await computeTransferMetadataHash(metadata);
        setConfirmationCode(
          await deriveConfirmationCode(session.rootKey, salt, {
            transferId,
            senderNonce: session.senderNonce,
            receiverNonce: session.receiverNonce,
            transcriptHash: session.transcriptHash,
            metadataHash,
          }),
        );

        setState({
          status: 'showing_confirmation_code',
          message: 'Read the confirmation code to the sender to start.',
          contentType: 'file',
          fileMetadata: {
            fileName: resolvedFileName,
            fileSize: resolvedFileSize,
            mimeType: resolvedMimeType,
          },
          useWebRTC: false,
          currentRelays: client.getRelays(),
          totalRelays: DEFAULT_RELAYS.length,
        });

        // Session keys are HKDF derivations off the same SPAKE2 root — the
        // PIN authenticated the exchange, and the exchange's fresh ephemeral
        // scalars supply the entropy.
        const sessionKeys: NostrSessionKeys = await deriveNostrSessionKeys(
          session.rootKey,
          salt,
        );

        // Decrypted chunks land in the receive sink as they arrive.
        const sink = resolvedFileSizeExact
          ? await createReceiveSink(resolvedFileSize)
          : await createAdaptiveAppendSink(resolvedFileSize);
        sinkRef.current = sink;

        if (cancelledRef.current) return;

        // Listener for the P2P transfer
        const transferResult = await new Promise<Blob>((resolve, reject) => {
          let rtc: WebRTCConnection | null = null;
          let settled = false;

          // Streaming receiver: decrypts each chunk into the sink as it
          // arrives. Nostr is not involved past signaling; the data-channel
          // ACK below confirms completion.
          const receiver = createDataChannelReceiver(
            sessionKeys.content,
            resolvedFileSizeExact ? resolvedFileSize : null,
            sink,
            {
              estimatedBytes: resolvedFileSize,
              onProgress: (current, total) =>
                setState((s) => ({
                  ...s,
                  status: 'receiving',
                  progress: { current, total },
                })),
            },
          );

          let cancelPoll: ReturnType<typeof setInterval> | null = null;
          let dataChannelOpened = false;
          let signalSeen = false;
          let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
          const clearConnectionTimeout = () => {
            if (connectionTimeout) {
              clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }
          };

          // Bound the pre-open phase: the stall watchdog only arms once the
          // data channel opens, so a sender that never completes WebRTC would
          // leave receiver.done unresolved without this. Two windows: a long
          // one while the sender's operator types the confirmation code (its
          // first signal is what ends that wait), then the ordinary
          // connection timeout once signaling has started. Cleared the moment
          // the channel opens (see below), on cancel, and on success/failure.
          const armConnectionTimeout = (delayMs: number) => {
            clearConnectionTimeout();
            connectionTimeout = setTimeout(() => {
              if (settled || dataChannelOpened) return;
              settled = true;
              if (cancelPoll) clearInterval(cancelPoll);
              client.unsubscribe(subId);
              try {
                if (rtc) rtc.close();
              } catch {
                // ignore
              }
              // Only a failure after signaling started is a connection
              // problem worth suggesting the offline-QR fallback for; before
              // that, the sender simply never entered the code.
              reject(
                signalSeen
                  ? new P2PConnectionError('WebRTC connection timeout')
                  : new Error(
                      'The sender did not enter the confirmation code in time. Start a new transfer.',
                    ),
              );
            }, delayMs);
          };
          armConnectionTimeout(OFFER_WAIT_TIMEOUT_MS);

          // cancel() only flips cancelledRef and closes the relay client; rtc is
          // local to this Promise and unreachable from there. Poll so a cancel
          // always settles the wait, even when rtc cannot be closed by cancel().
          // A stalled stream is aborted by the receiver's own idle watchdog.
          cancelPoll = setInterval(() => {
            if (cancelledRef.current && !settled) {
              settled = true;
              clearConnectionTimeout();
              receiver.dispose();
              if (cancelPoll) clearInterval(cancelPoll);
              client.unsubscribe(subId);
              try {
                if (rtc) rtc.close();
              } catch {
                // ignore
              }
              reject(new Error('Cancelled'));
            }
          }, 250);

          receiver.done
            .then((result) => {
              if (settled) return;
              settled = true;
              clearConnectionTimeout();
              if (cancelPoll) clearInterval(cancelPoll);
              client.unsubscribe(subId);
              // The file is fully received; a failure to send the ACK or tear
              // down rtc must not prevent the Promise from settling.
              try {
                if (rtc) {
                  const conn = rtc;
                  conn.send(ACK);
                  // Linger so the ACK reaches the sender; see ACK_LINGER_MS.
                  setTimeout(() => {
                    try {
                      conn.close();
                    } catch {
                      // ignore
                    }
                  }, ACK_LINGER_MS);
                }
              } catch (e) {
                console.error('ACK/teardown error', e);
              }
              resolve(result);
            })
            .catch((err) => {
              if (settled) return;
              settled = true;
              clearConnectionTimeout();
              if (cancelPoll) clearInterval(cancelPoll);
              client.unsubscribe(subId);
              try {
                if (rtc) rtc.close();
              } catch {
                // ignore
              }
              reject(err instanceof Error ? err : new Error('Transfer failed'));
            });

          const initWebRTC = () => {
            if (rtc) return rtc;

            rtc = new WebRTCConnection(
              getWebRTCConfig(),
              async (signal) => {
                const signalPayload = { type: 'signal', signal };
                const signalJson = JSON.stringify(signalPayload);
                const encryptedSignal = await encrypt(
                  sessionKeys.signals,
                  new TextEncoder().encode(signalJson),
                );
                const event = createSignalingEvent(
                  secretKey,
                  senderPubkey,
                  transferId,
                  encryptedSignal,
                );
                await client.publish(event);
              },
              () => {
                // Data channel opened; the idle watchdog covers the receiving
                // stage from here on, replacing the pre-open connection timeout.
                dataChannelOpened = true;
                clearConnectionTimeout();
                receiver.start();
                setState((s) => ({
                  ...s,
                  status: 'receiving',
                  message: 'Receiving via P2P...',
                  useWebRTC: true,
                }));
              },
              (data) => {
                if (settled) return;
                receiver.onMessage(data);
              },
            );
            return rtc;
          };

          const processedEventIds = new Set<string>();

          const processEvent = async (event: Event) => {
            if (settled) return;
            if (processedEventIds.has(event.id)) return;
            processedEventIds.add(event.id);

            const signalData = parseSignalingEvent(event);
            if (signalData && signalData.transferId === transferId) {
              try {
                const decrypted = await decrypt(
                  sessionKeys.signals,
                  signalData.encryptedSignal,
                );
                const signalPayload = JSON.parse(
                  new TextDecoder().decode(decrypted),
                );
                if (signalPayload.type === 'signal' && signalPayload.signal) {
                  // A signal that decrypts under the session's signals key
                  // means the sender's operator entered the code: the gate
                  // is open, the code has done its job, and the ordinary
                  // connection timeout takes over from the code-entry wait.
                  if (!signalSeen && !settled) {
                    signalSeen = true;
                    setConfirmationCode(null);
                    if (!dataChannelOpened) {
                      armConnectionTimeout(P2P_CONNECTION_TIMEOUT_MS);
                    }
                    setState((s) => ({
                      ...s,
                      status: 'receiving',
                      message: 'Sender confirmed — connecting...',
                    }));
                  }
                  const r = initWebRTC();
                  await r.handleSignal(signalPayload.signal);
                }
              } catch (e) {
                console.error('Signal handling error', e);
              }
            }
          };

          const subId = client.subscribe(
            [
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': [transferId],
                authors: [senderPubkey],
              },
            ],
            processEvent,
          );

          // Fire-and-forget: Query existing events in parallel with the live subscription.
          // This catches events published before we subscribed. Errors are logged inside.
          void (async () => {
            try {
              const existingEvents = await client.query([
                {
                  kinds: [EVENT_KIND_DATA_TRANSFER],
                  '#t': [transferId],
                  authors: [senderPubkey],
                  limit: 50,
                },
              ]);
              for (const event of existingEvents) {
                await processEvent(event);
              }
            } catch (err) {
              console.error('Failed to query existing events:', err);
            }
          })();
        });

        if (cancelledRef.current) return;

        // P2P transfer streamed already-decrypted chunks into the sink; this is
        // the sealed payload.
        const contentData = transferResult;

        if (cancelledRef.current) return;

        // Completion is confirmed to the sender via the data-channel ACK sent when
        // receiver.done resolved; no relay event is published post-transfer.

        // Set received content
        setReceivedContent({
          contentType: 'file',
          data: contentData,
          fileName: resolvedFileName,
          fileSize: contentData.size,
          mimeType: resolvedMimeType,
        });

        setState((prevState) => ({
          status: 'complete',
          message: 'File received (P2P)!',
          contentType: 'file',
          fileMetadata: {
            fileName: resolvedFileName,
            fileSize: contentData.size,
            mimeType: resolvedMimeType,
          },
          currentRelays: prevState.currentRelays,
          totalRelays: prevState.totalRelays,
          useWebRTC: prevState.useWebRTC,
        }));
      } catch (error) {
        // Nothing downloadable survives a failed transfer; drop its storage.
        discardSink();
        setConfirmationCode(null);
        if (!cancelledRef.current) {
          setState((prevState) => ({
            ...prevState,
            status: 'error',
            message:
              error instanceof Error ? error.message : 'Failed to receive',
            connectionFailed: error instanceof P2PConnectionError,
          }));
        }
      } finally {
        receivingRef.current = false;
        // Idempotent backstop for early exits — the happy path already wiped
        // it the moment the claims were built.
        wipeBufferSource(pinMaterial.pakeSecret);
        if (clientRef.current) {
          clientRef.current.close();
          clientRef.current = null;
        }
      }
    },
    [discardSink],
  );

  return { state, receivedContent, confirmationCode, receive, cancel, reset };
}
