import type { Event } from 'nostr-tools';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  CLAIM_VERIFY_LIMIT,
  computePinHintFromLocator,
  constantTimeEqual,
  decrypt,
  deriveConfirmationCode,
  deriveHandshakeSealKeys,
  deriveNostrSessionKeys,
  derivePakeSecret,
  encrypt,
  finishPake,
  generatePin,
  generateSalt,
  generateTransferId,
  getPinBucket,
  getPinLocator,
  isPinBucketActive,
  MAX_MESSAGE_SIZE,
  type NostrSessionKeys,
  normalizeCrockfordBase32,
  PIN_ROTATION_MS,
  PIN_WAIT_TIMEOUT_MS,
  startPake,
  wipeBufferSource,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import {
  type ClaimPayload,
  type ConfirmPayload,
  type ContentType,
  computeRendezvousTranscriptHash,
  computeTransferMetadataHash,
  createHandshakeEvent,
  createNostrClient,
  createRendezvousEvent,
  createSignalingEvent,
  DEFAULT_RELAYS,
  EVENT_KIND_DATA_TRANSFER,
  generateEphemeralKeys,
  generateHandshakeNonce,
  type NostrClient,
  openHandshakePayload,
  parseHandshakeEvent,
  parseSignalingEvent,
  type RendezvousPayload,
  sealHandshakePayload,
  type TransferMetadata,
  type TransferState,
  uint8ArrayToBase64,
} from '@/lib/nostr';
import { sendFileOverDataChannel } from '@/lib/p2p-transfer';
import type { TransferSource } from '@/lib/transfer-source';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';

/**
 * One rotation generation of the displayed PIN. Its absolute bucket lets the
 * sender reject it as soon as it is older than the immediately previous
 * bucket, regardless of timer delays or how many generations are retained.
 */
interface PinGeneration {
  /** SPAKE2 password scalar w for this generation's PIN (32 BE bytes). */
  pakeSecret: Uint8Array;
  /** SPAKE2 ephemeral scalar x behind this generation's published element. */
  pakeEphemeral: bigint;
  /** The published SPAKE2 element pA (33-byte compressed point). */
  pakeMessage: Uint8Array;
  nonce: string;
  bucket: number;
  /** Digest of the rendezvous published for this generation; see transcript.ts. */
  transcriptHash: string;
  /**
   * Remaining SPAKE2 claim verifications this generation will run. With a
   * PAKE, every verification attempt is exactly one online PIN guess for
   * whoever authored the claim, so this budget — not any key-stretching — is
   * the online guessing bound. Exhaustion stalls the generation (rotation
   * mints a fresh budget); see CLAIM_VERIFY_LIMIT.
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
 * Deliberately shorter than the receiver's confirm timeout: if the human is
 * too slow, the side with a person in front of it should be the one that
 * reports it, rather than publishing a confirm to a receiver that already
 * stopped listening.
 */
const CONFIRM_CODE_ENTRY_TIMEOUT_MS = 150000;

export interface UseNostrSendReturn {
  state: TransferState;
  pin: string | null;
  send: (content: TransferSource) => Promise<void>;
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

export function useNostrSend(): UseNostrSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [pin, setPin] = useState<string | null>(null);

  const clientRef = useRef<NostrClient | null>(null);
  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
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
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    setPin(null);
    setState({ status: 'idle' });
  }, []);

  const send = useCallback(async (content: TransferSource) => {
    // Guard against concurrent invocations
    if (sendingRef.current) return;
    sendingRef.current = true;
    cancelledRef.current = false;

    const contentType: ContentType = 'file';

    // Retained PIN generations. Declared outside the try so the finally block
    // can wipe any PAKE secrets left behind by an exceptional exit (cancel,
    // wait timeout, publish failure) that skipped the post-claim retirement.
    const generations: PinGeneration[] = [];

    try {
      // Validate and sanitize metadata
      const rawFileName = content.name || '';
      const sanitizedFileName = rawFileName.trim();

      if (!sanitizedFileName) {
        setState({ status: 'error', message: 'Missing file name' });
        sendingRef.current = false;
        return;
      }

      const fileName = sanitizedFileName;
      const fileSize = content.size ?? content.estimatedSize;
      const fileSizeExact = content.size !== null;
      const mimeType = content.type || 'application/octet-stream';

      if (
        !Number.isFinite(fileSize) ||
        fileSize < 0 ||
        !Number.isFinite(content.estimatedSize) ||
        content.estimatedSize < 0
      ) {
        setState({ status: 'error', message: 'Invalid file size' });
        sendingRef.current = false;
        return;
      }

      if (fileSizeExact && fileSize <= 0) {
        setState({ status: 'error', message: 'File is empty' });
        sendingRef.current = false;
        return;
      }

      if (
        fileSize > MAX_MESSAGE_SIZE ||
        content.estimatedSize > MAX_MESSAGE_SIZE
      ) {
        setState({
          status: 'error',
          message: `File exceeds ${formatFileSize(MAX_MESSAGE_SIZE)} limit`,
        });
        sendingRef.current = false;
        return;
      }

      // Per-transfer credentials: public salt (HKDF input for the session
      // keys) and an ephemeral Nostr identity. The shared secret protecting
      // signaling and content comes from the SPAKE2 run itself — each PIN
      // generation carries fresh ephemeral scalars, so there is no separate
      // ECDH key pair.
      const salt = generateSalt();
      const { secretKey, publicKey } = generateEphemeralKeys();
      const transferId = generateTransferId();

      const metadata: TransferMetadata = {
        contentType,
        fileName,
        fileSize,
        fileSizeExact,
        mimeType,
      };

      if (cancelledRef.current) return;

      // Create Nostr client for signaling
      setState({ status: 'connecting', message: 'Connecting to relays...' });
      const client = createNostrClient([...DEFAULT_RELAYS]);
      clientRef.current = client;
      await client.waitForConnection();

      if (cancelledRef.current) return;

      setState({
        status: 'waiting_for_receiver',
        message: 'Waiting for receiver...',
        contentType,
        fileMetadata: { fileName, fileSize, mimeType },
        useWebRTC: true,
        currentRelays: client.getRelays(),
        totalRelays: DEFAULT_RELAYS.length,
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

      const publishRendezvous = async () => {
        const epoch = pinEpoch;
        const newPin = generatePin();
        const bucket = getPinBucket();
        const [hint, pakeSecret] = await Promise.all([
          computePinHintFromLocator(getPinLocator(newPin), bucket),
          derivePakeSecret(newPin),
        ]);
        // Fresh SPAKE2 run per generation: a new ephemeral scalar behind a new
        // password-blinded element, so no published element ever replays.
        const { message: pakeMessage, secret: pakeEphemeral } = startPake(
          'sender',
          pakeSecret,
        );
        const nonce = generateHandshakeNonce();

        // Plaintext by design: the element is blinded, and nothing here may be
        // PIN-testable offline. File metadata deliberately stays out — it is
        // delivered inside the sealed confirm, after the handshake.
        const payload: RendezvousPayload = {
          type: 'rendezvous',
          transferId,
          senderPubkey: publicKey,
          pakeMessage: uint8ArrayToBase64(pakeMessage),
          nonce,
          relays: [...DEFAULT_RELAYS],
        };
        // Hash what we are about to publish, so a claim can be checked against
        // the rendezvous we actually sent rather than the one the claimant says
        // it saw. Per generation, since the nonce is fresh on every rotation.
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

        if (cancelledRef.current || epoch !== pinEpoch) {
          wipeBufferSource(pakeSecret);
          return;
        }

        // Register the generation before publishing so a fast claim can never
        // race ahead of the retained-keys list.
        generations.unshift({
          pakeSecret,
          pakeEphemeral,
          pakeMessage,
          nonce,
          bucket,
          transcriptHash,
          verifyBudget: CLAIM_VERIFY_LIMIT,
        });
        retireGenerations((generation) => isPinBucketActive(generation.bucket));

        await client.publish(event);

        if (!cancelledRef.current && epoch === pinEpoch) {
          setPin(newPin);
        }
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
          if (subId) client.unsubscribe(subId);
          rotationInterval = null;
          cancelPoll = null;
          timeout = null;
          subId = null;
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
          if (cancelledRef.current && !settled) {
            settled = true;
            cleanup();
            reject(new Error('Cancelled'));
          }
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
            if (settled || cancelledRef.current) return;
            if (processedEventIds.has(event.id)) return;
            processedEventIds.add(event.id);

            const handshake = parseHandshakeEvent(event);
            if (
              !handshake ||
              handshake.type !== 'claim' ||
              handshake.transferId !== transferId ||
              !handshake.pakeMessage
            ) {
              return;
            }
            const claimPakeMessage = handshake.pakeMessage;

            void (async () => {
              // A retained generation has no authority outside the sender's
              // current and immediately previous wall-clock buckets, and each
              // one runs at most CLAIM_VERIFY_LIMIT verifications — every
              // attempt is one online PIN guess for the claim's author, and
              // this counter is the only thing bounding those guesses.
              for (const generation of generations.filter(
                (candidate) =>
                  isPinBucketActive(candidate.bucket) &&
                  candidate.verifyBudget > 0,
              )) {
                generation.verifyBudget -= 1;

                // Finish our side of the SPAKE2 run against the claimant's
                // element, then try the claim seal. A wrong PIN (or a
                // different generation) lands on a different root key and the
                // seal simply refuses to open.
                try {
                  const rootKey = await finishPake(
                    'sender',
                    generation.pakeEphemeral,
                    generation.pakeSecret,
                    generation.pakeMessage,
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
                  // tie it to this exact generation and to the rendezvous we
                  // actually published, so a live-PIN attacker cannot
                  // republish our rendezvous with altered fields under its
                  // own identity and relay the real receiver's claim to us.
                  if (
                    p.type !== 'claim' ||
                    p.transferId !== transferId ||
                    p.senderNonce !== generation.nonce ||
                    typeof p.receiverNonce !== 'string' ||
                    !p.receiverNonce ||
                    p.senderPubkey !== publicKey ||
                    p.receiverPubkey !== event.pubkey ||
                    p.transcriptHash !== generation.transcriptHash ||
                    !isPinBucketActive(generation.bucket)
                  ) {
                    return;
                  }

                  if (settled) return;
                  settled = true;
                  cleanup();
                  resolve({
                    receiverPubkey: event.pubkey,
                    payload: p as ClaimPayload,
                    rootKey,
                    confirmKey: sealKeys.confirmKey,
                  });
                  return;
                } catch {
                  // Different PIN/generation, or an invalid element — try the
                  // next retained generation.
                }
              }
            })();
          },
        );

        const scheduleRotation = () => {
          if (rotationInterval) clearInterval(rotationInterval);
          rotationInterval = setInterval(() => {
            if (settled || cancelledRef.current) return;
            void publishRendezvous().catch((err) => {
              console.error('Failed to publish rendezvous rotation:', err);
            });
          }, PIN_ROTATION_MS);
        };

        // On-demand PIN reset: drop every retained generation so previously
        // shown PINs stop authenticating, restart the rotation cadence, and
        // publish a fresh rendezvous — reusing the transfer's file bytes,
        // keys, and relay connections.
        let refreshInFlight = false;
        refreshPinRef.current = async () => {
          if (settled || cancelledRef.current || refreshInFlight) return;
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
        void publishRendezvous().catch((err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error('Publish failed'));
        });
        scheduleRotation();
      });

      if (cancelledRef.current) return;

      // First-claim lockout: rotation has stopped, the retained generations
      // and their PAKE secrets are wiped, and only this receiver's events are
      // processed from here on. The PIN is no longer needed for display.
      setPin(null);
      retireGenerations(() => false);

      // Session keys are HKDF derivations off the SPAKE2 root the claim just
      // proved agreement on — the PIN authenticated the exchange, and the
      // exchange's fresh ephemeral scalars supply the entropy.
      const sessionKeys: NostrSessionKeys = await deriveNostrSessionKeys(
        claim.rootKey,
        salt,
      );

      const metadataHash = await computeTransferMetadataHash(metadata);

      // The claim proves whoever sent it knew a live PIN. That is exactly the
      // thing a shoulder-surfer or a screen-share viewer also knows, and the
      // lock above hands the transfer to whoever got here first. So stop: no
      // WebRTC signal, and no file byte, leaves this device until a human
      // vouches that the peer we locked onto is the peer they meant. The code
      // below proves possession of the locked session — a front-runner that
      // won the race holds that session and can compute it — but the operator
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

      if (cancelledRef.current) return;

      // Mutual proof plus metadata delivery: the confirm is sealed under the
      // session's confirm key, which only the matching PAKE peer holds, so
      // publishing it is this side's PIN proof in the reverse direction. It
      // goes out *before* the code gate — the receiver needs it to learn what
      // is being offered and to display the confirmation code at all. The
      // code gate guards the WebRTC offer and the file bytes, which is where
      // the actual harm lives.
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
      await client.publish(confirmEvent);

      if (cancelledRef.current) return;

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
            if (cancelledRef.current && !settled) {
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

      if (cancelledRef.current) return;

      // The typed code matched: the human vouched for the peer we locked
      // onto, so the gate opens and signaling may start.

      // WebRTC Transfer Logic (P2P only — no cloud fallback)
      let webRTCSuccess = false;

      try {
        setState((prevState) => ({
          ...prevState,
          status: 'connecting',
          message: 'Attempting P2P connection...',
        }));

        await new Promise<void>((resolve, reject) => {
          let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
          let offerRetryInterval: ReturnType<typeof setInterval> | null = null;
          let signalSubId: string | null = null;
          let answerReceived = false;
          const processedEventIds = new Set<string>();

          const processSignalEvent = async (event: Event) => {
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
                  if (signalPayload.signal.type === 'answer') {
                    answerReceived = true;
                    if (offerRetryInterval) {
                      clearInterval(offerRetryInterval);
                      offerRetryInterval = null;
                    }
                  }
                  await rtc.handleSignal(signalPayload.signal);
                }
              } catch (err) {
                console.error('Failed to process signaling event:', err);
              }
            }
          };

          const cleanup = () => {
            if (connectionTimeout) {
              clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }
            if (offerRetryInterval) {
              clearInterval(offerRetryInterval);
              offerRetryInterval = null;
            }
            if (signalSubId) {
              client.unsubscribe(signalSubId);
              signalSubId = null;
            }
          };

          const rtc = new WebRTCConnection(
            getWebRTCConfig(),
            async (signal) => {
              if (cancelledRef.current) return;
              const signalPayload = { type: 'signal', signal };
              const signalJson = JSON.stringify(signalPayload);
              const encryptedSignal = await encrypt(
                sessionKeys.signals,
                new TextEncoder().encode(signalJson),
              );
              const event = createSignalingEvent(
                secretKey,
                publicKey,
                transferId,
                encryptedSignal,
              );
              await client.publish(event);
            },
            async () => {
              cleanup();

              setState((prevState) => ({
                status: 'transferring',
                message: 'Sending via P2P...',
                progress: { current: 0, total: fileSize },
                contentType,
                fileMetadata: { fileName, fileSize, mimeType },
                currentRelays: prevState.currentRelays,
                totalRelays: prevState.totalRelays,
                useWebRTC: true,
              }));

              try {
                // After the data channel is open, nostr is no longer involved:
                // completion is the data-channel ACK awaited here.
                await sendFileOverDataChannel(
                  rtc,
                  sessionKeys.content,
                  content,
                  {
                    onProgress: (current, total) =>
                      setState((s) => ({
                        ...s,
                        progress: { current, total },
                      })),
                    isCancelled: () => cancelledRef.current,
                  },
                );
                webRTCSuccess = true;
                resolve();
              } catch (err) {
                reject(err);
              } finally {
                // The local peer connection is scoped to this Promise and is
                // not reachable from the outer catch/finally, so close it here
                // on success, error, or cancellation to avoid leaking it.
                try {
                  rtc.close();
                } catch {
                  // ignore
                }
              }
            },
            () => {
              // Data-channel messages are not used by the auto-mode sender.
            },
          );

          signalSubId = client.subscribe(
            [
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': [transferId],
                '#p': [publicKey],
                authors: [claim.receiverPubkey],
              },
            ],
            processSignalEvent,
          );

          const queryForExistingSignals = async () => {
            try {
              const existingEvents = await client.query([
                {
                  kinds: [EVENT_KIND_DATA_TRANSFER],
                  '#t': [transferId],
                  '#p': [publicKey],
                  authors: [claim.receiverPubkey],
                  limit: 50,
                },
              ]);
              for (const event of existingEvents) {
                await processSignalEvent(event);
              }
            } catch (err) {
              console.error('Failed to query existing signal events:', err);
            }
          };

          rtc.createDataChannel('file-transfer');
          void rtc.createOffer();
          void queryForExistingSignals();

          let retryCount = 0;
          offerRetryInterval = setInterval(async () => {
            if (answerReceived || webRTCSuccess || cancelledRef.current) {
              if (offerRetryInterval) {
                clearInterval(offerRetryInterval);
                offerRetryInterval = null;
              }
              return;
            }

            retryCount++;
            console.log(`Retrying WebRTC offer (attempt ${retryCount + 1})...`);
            await queryForExistingSignals();
            if (!answerReceived && !webRTCSuccess) {
              void rtc.createOffer();
            }
          }, 5000);

          connectionTimeout = setTimeout(() => {
            if (!webRTCSuccess) {
              cleanup();
              rtc.close();
              reject(new P2PConnectionError('WebRTC connection timeout'));
            }
          }, 30000);
        });
      } catch (err) {
        const message = `P2P transfer failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
        // Preserve the connection-failure distinction so the UI can suggest
        // the offline-QR fallback only when P2P could not be established.
        throw err instanceof P2PConnectionError
          ? new P2PConnectionError(message)
          : new Error(message);
      }

      // Completion is confirmed by the data-channel ACK (awaited inside
      // sendFileOverDataChannel). Nostr is not involved past signaling.
      setState((prevState) => ({
        status: 'complete',
        message: 'File sent via P2P!',
        contentType,
        currentRelays: prevState.currentRelays,
        totalRelays: prevState.totalRelays,
        useWebRTC: prevState.useWebRTC,
      }));
    } catch (error) {
      if (!cancelledRef.current) {
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
      sendingRef.current = false;
      expectedConfirmationCodeRef.current = null;
      confirmationCodeAcceptRef.current = null;
      if (clientRef.current) {
        clientRef.current.close();
        clientRef.current = null;
      }
    }
  }, []);

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, pin, send, cancel, refreshPin, submitConfirmationCode }),
    [state, pin, send, cancel, refreshPin, submitConfirmationCode],
  );
}
