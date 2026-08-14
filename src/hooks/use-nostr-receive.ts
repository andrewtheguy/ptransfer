import type { Event } from 'nostr-tools';
import { useCallback, useRef, useState } from 'react';
import {
  computePinHintFromLocator,
  decrypt,
  deriveConfirmationCode,
  deriveNostrSessionKeys,
  derivePinAuthKey,
  derivePinRendezvousKey,
  deriveSharedSecretKey,
  encrypt,
  generateECDHKeyPair,
  getPinBucket,
  MAX_MESSAGE_SIZE,
  type NostrSessionKeys,
  PIN_HINT_LOOKBACK_BUCKETS,
  PIN_TTL_MS,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import {
  base64ToUint8Array,
  type ClaimPayload,
  type ConfirmPayload,
  computeRendezvousTranscriptHash,
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
  type TransferState,
  uint8ArrayToBase64,
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
 * Time to establish the WebRTC data channel after the handshake completes.
 * Bounds the pre-open phase, which the per-transfer stall watchdog does not
 * cover (it only arms once the channel opens). Mirrors the sender's timeout.
 */
const P2P_CONNECTION_TIMEOUT_MS = 30000;

/**
 * Time to wait for the sender's confirm after publishing the claim.
 *
 * Generous because a human is in the loop: the sender does not confirm on
 * verifying a claim any more, it waits for its operator to type the
 * confirmation code this side is displaying. The budget has to cover reading
 * eight characters aloud over a phone call and someone typing them back.
 *
 * The sender's own entry deadline is deliberately shorter than this window, so
 * a slow typist makes the sender report the timeout rather than this side
 * giving up on a confirm that is still coming.
 */
const CONFIRM_TIMEOUT_MS = 180000;

/**
 * How long to keep the peer connection alive after sending the final ACK.
 * The sender closes the connection as soon as the ACK arrives; this delayed
 * close is only a fallback for a sender that never does. Closing in the same
 * tick as the send can tear the transport down before the ACK datagram is
 * delivered, making the sender report "data channel closed before
 * acknowledgment" even though the transfer succeeded.
 */
const ACK_LINGER_MS = 3000;

function decodeEcdhPublicKey(b64: string): Uint8Array | null {
  try {
    const bytes = base64ToUint8Array(b64);
    if (bytes.length !== 65 || bytes[0] !== 0x04) return null;
    return bytes;
  } catch {
    return null;
  }
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
        if (!pinMaterial.key || !pinMaterial.locator) {
          setState({
            status: 'error',
            message: 'PIN unavailable. Please re-enter.',
          });
          receivingRef.current = false;
          return;
        }

        setState({
          status: 'connecting',
          message: 'Deriving lookup keys...',
        });

        // Mirror the sender's acceptance rule by deriving the receiver's
        // current and immediately previous rotation buckets.
        const root = pinMaterial.key;
        const currentBucket = getPinBucket();
        const [hints, rendezvousKey, authKey] = await Promise.all([
          Promise.all(
            Array.from({ length: PIN_HINT_LOOKBACK_BUCKETS + 1 }, (_, offset) =>
              computePinHintFromLocator(
                pinMaterial.locator,
                currentBucket - offset,
              ),
            ),
          ),
          derivePinRendezvousKey(root),
          derivePinAuthKey(root),
        ]);

        if (cancelledRef.current) return;

        // Connect to relays
        setState({ status: 'connecting', message: 'Connecting to relays...' });
        const client = createNostrClient([...DEFAULT_RELAYS]);
        clientRef.current = client;

        if (cancelledRef.current) return;

        // Search for the rendezvous event
        setState({ status: 'receiving', message: 'Searching for sender...' });

        // The hint is derived from the PIN's public locator segment, so it
        // carries only ~18 bits and unrelated transfers sharing a bucket do
        // collide. The loop below authenticates each candidate, but a tight
        // limit could truncate the real event away before it gets there.
        //
        // A flood of forged events sharing the tag can still push the real one
        // out of this page. That is a stall, not a compromise — every candidate
        // below must decrypt under the PIN rendezvous key and name its own
        // author and transfer id, so truncation ends in "no transfer found",
        // never in the wrong event being accepted. Paginating instead would not
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

        // Try to decrypt each candidate
        let payload: RendezvousPayload | null = null;
        let transferId: string | null = null;
        let senderPubkey: string | null = null;
        let senderEcdhPublicKey: Uint8Array | null = null;
        let salt: Uint8Array | null = null;
        let sawExpiredCandidate = false;

        const sortedEvents = [...events].sort(
          (a, b) => (b.created_at || 0) - (a.created_at || 0),
        );

        for (const event of sortedEvents) {
          // A rendezvous event is only claimable while the sender still honors
          // its PIN generation.
          if (
            !event.created_at ||
            Date.now() - event.created_at * 1000 > PIN_TTL_MS
          ) {
            sawExpiredCandidate = true;
            continue;
          }

          const parsed = parseRendezvousEvent(event);
          if (!parsed) continue;

          let candidate: RendezvousPayload;
          try {
            const decrypted = await decrypt(
              rendezvousKey,
              parsed.encryptedPayload,
            );
            candidate = JSON.parse(
              new TextDecoder().decode(decrypted),
            ) as RendezvousPayload;
          } catch {
            // Not sealed with our PIN (stale event sharing the hint tag); try
            // the next candidate.
            continue;
          }

          // Bind the authenticated payload to the plaintext routing data: the
          // payload must name the event's own author and transfer id, so a
          // copied ciphertext republished under another identity is rejected.
          const ecdhBytes =
            typeof candidate.ecdhPublicKey === 'string'
              ? decodeEcdhPublicKey(candidate.ecdhPublicKey)
              : null;
          if (
            candidate.type !== 'rendezvous' ||
            candidate.transferId !== parsed.transferId ||
            candidate.senderPubkey !== event.pubkey ||
            typeof candidate.nonce !== 'string' ||
            !candidate.nonce ||
            !ecdhBytes
          ) {
            continue;
          }

          payload = candidate;
          transferId = parsed.transferId;
          senderPubkey = event.pubkey;
          senderEcdhPublicKey = ecdhBytes;
          salt = parsed.salt;
          break;
        }

        if (
          !payload ||
          !transferId ||
          !senderPubkey ||
          !senderEcdhPublicKey ||
          !salt
        ) {
          setState({
            status: 'error',
            message: sawExpiredCandidate
              ? 'This PIN has expired. Enter the code currently shown on the sender.'
              : 'Could not decrypt transfer. Wrong PIN?',
          });
          return;
        }

        if (cancelledRef.current) return;

        // Validate payload
        if (
          payload.fileSize == null ||
          !Number.isFinite(payload.fileSize) ||
          payload.fileSize < 0 ||
          typeof payload.fileSizeExact !== 'boolean'
        ) {
          setState({
            status: 'error',
            message: 'Invalid file size in transfer',
          });
          return;
        }

        const resolvedFileName = payload.fileName || 'unknown';
        const resolvedFileSize = payload.fileSize;
        const resolvedFileSizeExact = payload.fileSizeExact;
        const resolvedMimeType = payload.mimeType || 'application/octet-stream';

        if (resolvedFileSize > MAX_MESSAGE_SIZE) {
          setState({
            status: 'error',
            message: `Transfer rejected: Size (${formatFileSize(resolvedFileSize)}) exceeds limit (${formatFileSize(MAX_MESSAGE_SIZE)})`,
          });
          return;
        }

        // Claim the transfer: prove PIN knowledge and bind our ephemeral ECDH
        // key (and the sender's) into the sealed payload.
        const { secretKey, publicKey } = generateEphemeralKeys();
        const ecdh = await generateECDHKeyPair();
        const receiverEcdhPublicKeyB64 = uint8ArrayToBase64(
          ecdh.publicKeyBytes,
        );
        const receiverNonce = generateHandshakeNonce();

        // Derived before the claim goes out, not after the confirm comes back.
        // Opening the rendezvous payload already proved we knew the PIN, and
        // the sender's ECDH key came out of that same authenticated payload —
        // bound to the event author and transfer id — so agreeing on the shared
        // secret now discloses nothing and commits to nothing the claim below
        // does not already commit to. It buys the confirmation code, which the
        // sender needs from us before it will confirm at all.
        const sharedSecret = await deriveSharedSecretKey(
          ecdh.privateKey,
          senderEcdhPublicKey,
        );

        // Hash the rendezvous we actually acted on. The sender compares it with
        // the one it published and refuses the claim on any difference, so a
        // republished rendezvous carrying rewritten file metadata never reaches
        // the point where the two humans compare codes.
        const transcriptHash = await computeRendezvousTranscriptHash(
          payload,
          salt,
        );

        const claimPayload: ClaimPayload = {
          type: 'claim',
          transferId,
          senderNonce: payload.nonce,
          receiverNonce,
          receiverEcdhPublicKey: receiverEcdhPublicKeyB64,
          senderEcdhPublicKey: payload.ecdhPublicKey,
          senderPubkey,
          receiverPubkey: publicKey,
          transcriptHash,
        };
        const claimEvent = createHandshakeEvent(
          secretKey,
          senderPubkey,
          transferId,
          'claim',
          await sealHandshakePayload(authKey, claimPayload),
        );

        // The sender will not confirm — and will not send a byte — until its
        // operator types this code. Someone who front-ran us with a stolen PIN
        // holds a different ECDH key, so the code on their screen is not the
        // one the sender is about to be told.
        setConfirmationCode(
          await deriveConfirmationCode(sharedSecret, salt, {
            transferId,
            senderNonce: payload.nonce,
            receiverNonce,
            transcriptHash,
          }),
        );

        setState({
          status: 'showing_confirmation_code',
          message: 'Read the confirmation code to the sender to start.',
        });

        // Subscribe for the confirm before publishing the claim so the response
        // cannot slip past us, then verify it under the same PIN auth key.
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | null = null;
          let cancelPoll: ReturnType<typeof setInterval> | null = null;
          let queryPoll: ReturnType<typeof setInterval> | null = null;
          let subId: string | null = null;

          const cleanup = () => {
            if (timeout) clearTimeout(timeout);
            if (cancelPoll) clearInterval(cancelPoll);
            if (queryPoll) clearInterval(queryPoll);
            if (subId) client.unsubscribe(subId);
            timeout = null;
            cancelPoll = null;
            queryPoll = null;
            subId = null;
          };

          timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(
              new Error(
                'Sender did not confirm. The transfer may have been claimed by another device, or the sender went offline.',
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
            if (
              !handshake ||
              handshake.type !== 'confirm' ||
              handshake.transferId !== transferId ||
              event.pubkey !== senderPubkey
            ) {
              return;
            }

            void (async () => {
              let opened: unknown;
              try {
                opened = await openHandshakePayload(
                  authKey,
                  handshake.sealedPayload,
                );
              } catch {
                return; // Not sealed with our PIN
              }

              const p = opened as Partial<ConfirmPayload>;
              if (
                p.type !== 'confirm' ||
                p.transferId !== transferId ||
                p.senderNonce !== payload.nonce ||
                p.receiverNonce !== receiverNonce ||
                p.receiverEcdhPublicKey !== receiverEcdhPublicKeyB64 ||
                p.senderPubkey !== event.pubkey ||
                p.receiverPubkey !== publicKey ||
                p.transcriptHash !== transcriptHash
              ) {
                return;
              }

              if (settled) return;
              settled = true;
              cleanup();
              resolve();
            })();
          };

          subId = client.subscribe(
            [
              {
                kinds: [EVENT_KIND_DATA_TRANSFER],
                '#t': [transferId],
                '#p': [publicKey],
                authors: [senderPubkey],
              },
            ],
            processEvent,
          );

          const publishAndPoll = async () => {
            await client.publish(claimEvent);
            // Backstop for relays that processed the publish before the
            // subscription: poll for an already-stored confirm.
            queryPoll = setInterval(() => {
              if (settled || cancelledRef.current) return;
              void (async () => {
                try {
                  const existing = await client.query([
                    {
                      kinds: [EVENT_KIND_DATA_TRANSFER],
                      '#t': [transferId],
                      '#p': [publicKey],
                      authors: [senderPubkey],
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

        if (cancelledRef.current) return;

        // The confirm proves the sender matched our code and locked onto us;
        // the code has done its job and should not linger on screen.
        setConfirmationCode(null);

        // Session keys come from the ephemeral ECDH exchange the PIN just
        // authenticated — the PIN derives no content or signaling keys.
        const sessionKeys: NostrSessionKeys = await deriveNostrSessionKeys(
          sharedSecret,
          salt,
        );

        setState({
          status: 'receiving',
          message: 'Receiving file...',
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
          let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
          const clearConnectionTimeout = () => {
            if (connectionTimeout) {
              clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }
          };

          // Bound the pre-open phase: the stall watchdog only arms once the data
          // channel opens, so a sender that never completes WebRTC would leave
          // receiver.done unresolved without this. Cleared the moment the channel
          // opens (see below), on cancel, and on success/failure.
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
            reject(new P2PConnectionError('WebRTC connection timeout'));
          }, P2P_CONNECTION_TIMEOUT_MS);

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
