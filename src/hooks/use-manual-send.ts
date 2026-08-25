import { useCallback, useMemo, useRef, useState } from 'react';
import {
  type AnswerChannel,
  type AnswerWatch,
  deriveAnswerChannel,
  generateAnswerSecret,
  watchForAnswer,
} from '@/lib/answer-channel';
import {
  deriveAESKeyFromSecretKey,
  deriveSharedSecretKey,
  generateECDHKeyPair,
  generateSalt,
  MAX_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import {
  generateMutualOfferBinary,
  parseMutualPayload,
  type SignalingPayload,
} from '@/lib/manual-signaling';
import {
  CLOCK_SKEW_TOLERANCE_SEC,
  NOSTR_FILE_MAX_BYTES,
} from '@/lib/nostr-file/constants';
import { createIndexedDbRelayPool } from '@/lib/nostr-file/relay-pool';
import { deriveRelaySession } from '@/lib/nostr-file/session';
import {
  createTransferStats,
  type NostrFileTransferStats,
} from '@/lib/nostr-file/stats';
import { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import {
  NostrFileCancelledError,
  type PreparedStorageRelays,
  prepareStorageRelays,
  resolveTransferRelays,
  type TransferRelaySelection,
} from '@/lib/nostr-file/upload';
import { sendFileLive } from '@/lib/nostr-file/upload-live';
import { sendFileOverDataChannel } from '@/lib/p2p-transfer';
import { type TransferSource, wireEncodingFor } from '@/lib/transfer-source';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';
import { chunkBytesEstimate, readSourceFully } from './nostr-relay-source';

// Extended transfer status for Manual Exchange mode
export type ManualTransferStatus =
  | 'idle'
  | 'generating_offer'
  | 'showing_offer'
  | 'waiting_for_answer'
  | 'connecting'
  | 'transferring'
  // Relay fallback after a failed direct connection: hashing the file,
  // finding storage relays, uploading pieces as the receiver fetches them.
  | 'preparing'
  | 'discovering_relays'
  | 'uploading'
  | 'complete'
  | 'error';

// Base properties for manual transfer state
interface ManualTransferStateBase {
  progress?: {
    current: number;
    total: number;
  };
  contentType?: 'file';
  fileMetadata?: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  };
  useWebRTC?: boolean;
  currentRelays?: string[];
  totalRelays?: number;
  offerData?: Uint8Array; // Binary data for QR code
  /**
   * Answer-return channel state while the offer is up: 'waiting' when the
   * receiver's response will arrive over relays on its own, 'unavailable'
   * when no relay set was proven and it has to be scanned or pasted back.
   */
  answerRelayStatus?: 'waiting' | 'unavailable';
  // Set on an error state when a direct P2P connection could not be established;
  // drives the offline-QR fallback suggestion in the UI.
  connectionFailed?: boolean;
  /** Relay fallback: running totals for the relay transfer. */
  stats?: NostrFileTransferStats;
}

// Error state has required message
interface ManualTransferStateError extends ManualTransferStateBase {
  status: 'error';
  message: string;
}

// All other states have optional message
interface ManualTransferStateOther extends ManualTransferStateBase {
  status: Exclude<ManualTransferStatus, 'error'>;
  message?: string;
}

// Discriminated union for manual transfer state
export type ManualTransferState =
  | ManualTransferStateError
  | ManualTransferStateOther;

export interface UseManualSendReturn {
  state: ManualTransferState;
  send: (content: TransferSource) => Promise<void>;
  submitAnswer: (answerData: Uint8Array) => void;
  cancel: () => void;
}

const ICE_GATHER_TIMEOUT_MS = 5000;

/** What the sender is doing while it resolves the offer's relays. */
type RelayResolvePhase =
  | 'probing_defaults'
  | 'discovering'
  | 'probing_discovered';
/** Shown only when relay resolution outlasts WebRTC offer creation. */
const RELAY_PHASE_MESSAGES: Record<RelayResolvePhase, string> = {
  probing_defaults: 'Checking relays for the response...',
  discovering: 'Looking for more storage relays to back them up...',
  probing_discovered: 'Testing the storage relays we found...',
};
const MANUAL_CONNECTION_TIMEOUT_MS = 120000;
// When a relay fallback is available, the direct attempt is capped well below
// the full timeout: the offerer keeps real candidates to try against the
// receiver's unreachable ones, so its ICE agent is slow to declare failure,
// while the receiver (with no viable candidates) has already given up. A
// direct connection that is going to work opens in a few seconds; if none has
// after this window, relay it rather than ride out the full backstop.
const RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS = 20000;
const RELAY_FALLBACK_MESSAGE =
  'No direct connection — relaying the file through Nostr instead';

export function useManualSend(): UseManualSendReturn {
  const [state, setState] = useState<ManualTransferState>({ status: 'idle' });

  const rtcRef = useRef<WebRTCConnection | null>(null);
  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  const expirationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Store ECDH private key for computing shared secret when answer arrives
  const ecdhPrivateKeyRef = useRef<CryptoKey | null>(null);
  const saltRef = useRef<Uint8Array | null>(null);

  // Resolve function for answer submission
  const answerResolverRef = useRef<
    ((payload: SignalingPayload) => void) | null
  >(null);
  const answerRejectRef = useRef<((error: Error) => void) | null>(null);

  // Relay pool and subscription carrying the receiver's answer back.
  const poolRef = useRef<ReturnType<typeof createTransferPool> | null>(null);
  const answerWatchRef = useRef<AnswerWatch | null>(null);
  // Storage-ring preparation and the relay enumeration running on behind
  // the exchange; aborted with the pool so a teardown never waits out a
  // probe, and never records its own teardown as relay failures.
  const sweepAbortRef = useRef<AbortController | null>(null);
  // A relayed answer that landed before the flow was ready for it. The watch
  // stops at the first one, so it is held here rather than dropped.
  const pendingAnswerRef = useRef<Uint8Array | null>(null);

  const closeAnswerWatch = useCallback(() => {
    answerWatchRef.current?.close();
    answerWatchRef.current = null;
  }, []);

  const teardownAnswerRelay = useCallback(() => {
    closeAnswerWatch();
    sweepAbortRef.current?.abort();
    sweepAbortRef.current = null;
    poolRef.current?.destroy();
    poolRef.current = null;
  }, [closeAnswerWatch]);

  const clearExpirationTimeout = useCallback(() => {
    if (expirationTimeoutRef.current) {
      clearTimeout(expirationTimeoutRef.current);
      expirationTimeoutRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    sendingRef.current = false;
    clearExpirationTimeout();
    teardownAnswerRelay();
    pendingAnswerRef.current = null;
    answerResolverRef.current = null;
    answerRejectRef.current = null;
    ecdhPrivateKeyRef.current = null;
    saltRef.current = null;
    if (rtcRef.current) {
      rtcRef.current.close();
      rtcRef.current = null;
    }
    setState({ status: 'idle' });
  }, [clearExpirationTimeout, teardownAnswerRelay]);

  // Both paths to an answer — the relay channel and a scanned/pasted code —
  // land here, so validation and TTL enforcement stay in one place.
  const submitAnswer = useCallback(async (answerBinary: Uint8Array) => {
    if (!answerResolverRef.current) return;

    // Parse mutual payload (no decryption needed)
    const parsed = await parseMutualPayload(answerBinary);
    if (!parsed) {
      answerRejectRef.current?.(new Error('Invalid response format'));
      answerResolverRef.current = null;
      return;
    }
    if (parsed.type !== 'answer') {
      answerRejectRef.current?.(new Error('Expected answer, got offer'));
      answerResolverRef.current = null;
      return;
    }
    if (
      typeof parsed.createdAt !== 'number' ||
      !Number.isFinite(parsed.createdAt)
    ) {
      answerRejectRef.current?.(
        new Error(
          `Invalid response: missing or invalid timestamp (got ${String(parsed.createdAt)})`,
        ),
      );
      answerResolverRef.current = null;
      return;
    }
    answerResolverRef.current?.(parsed);
  }, []);

  const send = useCallback(
    async (content: TransferSource) => {
      // Guard against concurrent invocations
      if (sendingRef.current) return;
      sendingRef.current = true;
      cancelledRef.current = false;
      pendingAnswerRef.current = null;

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
        const contentEncoding = wireEncodingFor(content);
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

        if (content.size !== null && fileSize <= 0) {
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

        // Generate ECDH keypair and salt
        setState({ status: 'generating_offer', message: 'Generating keys...' });
        const sessionStartTime = Date.now();

        const ecdhKeyPair = await generateECDHKeyPair();
        ecdhPrivateKeyRef.current = ecdhKeyPair.privateKey;
        const salt = generateSalt();
        saltRef.current = salt;

        // Resolve the relays the offer will name while WebRTC creates the
        // offer and gathers candidates, so the probe of the defaults costs no
        // extra wait. Robustness matches the storage transfer: the defaults
        // are control-probed, and a defunct default is replaced by a
        // full-size-proven storage reserve, not a weaker control-sized
        // discovery — so the same discovery pass may run and can outlast ICE
        // gathering, which is reported and waited out. A failure or a set
        // below the floor is caught: the offer simply goes out manual-only and
        // the answer is scanned or pasted back as before.
        teardownAnswerRelay();
        const pool = createTransferPool();
        poolRef.current = pool;
        const relayStorage = createIndexedDbRelayPool();
        const relayStats = createTransferStats('sender');
        const answerSecret = generateAnswerSecret();
        let relayPhase: RelayResolvePhase = 'probing_defaults';
        let relayDone = false;
        let awaitingRelays = false;
        const showRelayPhase = () => {
          if (!awaitingRelays || cancelledRef.current) return;
          setState({
            status: 'generating_offer',
            message: RELAY_PHASE_MESSAGES[relayPhase],
          });
        };
        const relayProbe: Promise<TransferRelaySelection | null> =
          resolveTransferRelays(pool, relayStorage, {
            isCancelled: () => cancelledRef.current,
            stats: relayStats,
            onControlProgress: () => {
              relayPhase = 'probing_defaults';
              showRelayPhase();
            },
            onUploadProgress: (p) => {
              relayPhase =
                p.phase === 'discovering'
                  ? 'discovering'
                  : 'probing_discovered';
              showRelayPhase();
            },
          })
            .then((selection) => {
              relayDone = true;
              return selection;
            })
            .catch(() => {
              relayDone = true;
              return null;
            });

        // Set expiration timeout
        clearExpirationTimeout();
        expirationTimeoutRef.current = setTimeout(() => {
          if (!cancelledRef.current && sendingRef.current) {
            setState({
              status: 'error',
              message: 'Session expired. Please try again.',
            });
            sendingRef.current = false;
            answerResolverRef.current = null;
            teardownAnswerRelay();
            ecdhPrivateKeyRef.current = null;
            saltRef.current = null;
            if (rtcRef.current) {
              rtcRef.current.close();
              rtcRef.current = null;
            }
          }
        }, TRANSFER_EXPIRATION_MS);

        if (cancelledRef.current) return;

        // Create WebRTC connection and offer
        setState({
          status: 'generating_offer',
          message: 'Creating P2P offer...',
        });

        const iceCandidates: RTCIceCandidate[] = [];
        let offerSDP: RTCSessionDescriptionInit | null = null;

        const rtc = new WebRTCConnection(
          getWebRTCConfig(),
          (signal) => {
            // Collect signals (offer + candidates)
            if (signal.type === 'offer') {
              offerSDP = { type: 'offer', sdp: signal.sdp };
            } else if (signal.type === 'candidate' && signal.candidate) {
              iceCandidates.push(new RTCIceCandidate(signal.candidate));
            }
          },
          () => {
            // Data channel opened - will be handled later
          },
          () => {
            // Message received - will be handled later
          },
        );

        rtcRef.current = rtc;
        rtc.createDataChannel('file-transfer');

        // Create offer
        await rtc.createOffer();

        if (cancelledRef.current) return;

        // Wait for ICE gathering to complete
        setState({
          status: 'generating_offer',
          message: 'Gathering network info...',
        });
        const iceGatheringComplete = await rtc.waitForIceGatheringComplete(
          ICE_GATHER_TIMEOUT_MS,
        );
        if (!iceGatheringComplete) {
          console.warn(
            'ICE gathering timed out while generating offer; continuing with available candidates',
          );
        }
        setState({
          status: 'generating_offer',
          message: iceGatheringComplete
            ? 'Preparing exchange code...'
            : 'Network probe timed out. Preparing exchange code with available routes...',
        });

        if (cancelledRef.current) return;

        if (!relayDone) {
          awaitingRelays = true;
          showRelayPhase();
        }
        const selection = await relayProbe;
        awaitingRelays = false;
        if (cancelledRef.current) return;
        const answerRelays = selection?.controlRelays ?? [];
        let channel: AnswerChannel | null = null;
        // Set once the direct attempt has failed: from then on the storage
        // preparation's progress is the transfer's progress.
        let relayFallbackActive = false;
        let storageRelays: PreparedStorageRelays | null = null;
        if (selection && answerRelays.length > 0) {
          // The signaling relays are settled; the storage ring is prepared in
          // the background on the same pool and relay cache — the offer's QR
          // does not depend on it. When the signaling fallback already had to
          // discover and full-size-probe a ring to borrow reserves, that ring
          // is adopted as-is (`preselected`) instead of discovered again;
          // otherwise discovery runs here. Either way the sweep then keeps
          // probing the rest of the population for as long as the exchange
          // lasts, warming the shared cache and handing a failed direct
          // attempt its ring ready-made. It ends with the pool.
          const sweepAbort = new AbortController();
          sweepAbortRef.current = sweepAbort;
          storageRelays = prepareStorageRelays(pool, {
            controlRelays: answerRelays,
            storage: relayStorage,
            stats: selection.stats,
            preselected: selection.storageRelays
              ? {
                  storageRelays: selection.storageRelays,
                  unprobedCandidates: selection.unprobedCandidates,
                }
              : null,
            signal: sweepAbort.signal,
            isCancelled: () => cancelledRef.current,
            onProgress: (p) => {
              if (!relayFallbackActive || cancelledRef.current) return;
              setState({
                status: 'discovering_relays',
                message:
                  p.phase === 'discovering'
                    ? `${RELAY_FALLBACK_MESSAGE}. Finding storage relays...`
                    : `${RELAY_FALLBACK_MESSAGE}. Testing storage relays... ${p.relaysHealthy ?? 0} working of ${p.relaysChecked ?? 0} checked`,
                contentType: 'file',
                fileMetadata: { fileName, fileSize, mimeType },
                currentRelays: answerRelays,
                stats: p.stats,
              });
            },
          });
          channel = await deriveAnswerChannel(answerSecret);
        } else {
          teardownAnswerRelay();
        }

        // Generate binary offer data with ECDH public key
        const offerBinary = await generateMutualOfferBinary(
          offerSDP!,
          iceCandidates,
          {
            createdAt: sessionStartTime,
            fileName,
            fileSize,
            contentEncoding,
            mimeType,
            publicKey: ecdhKeyPair.publicKeyBytes,
            salt,
            ...(channel ? { answerRelays, answerSecret } : {}),
          },
        );

        if (cancelledRef.current) return;

        // Listen for the sealed answer before the code is shared, so one
        // published while we were still preparing is not missed.
        if (channel) {
          answerWatchRef.current = watchForAnswer(pool, answerRelays, {
            channel,
            since:
              Math.floor(sessionStartTime / 1000) - CLOCK_SKEW_TOLERANCE_SEC,
            onAnswer: (binary) => {
              if (answerResolverRef.current) void submitAnswer(binary);
              else pendingAnswerRef.current = binary;
            },
          });
        }

        // Show offer and wait for answer
        setState({
          status: 'showing_offer',
          message: channel
            ? 'Show this to receiver — their response comes back on its own'
            : 'Show this to receiver, then scan/paste their response',
          offerData: offerBinary,
          contentType: 'file',
          fileMetadata: { fileName, fileSize, mimeType },
          answerRelayStatus: channel ? 'waiting' : 'unavailable',
        });

        // Wait for answer to be submitted
        const answerPayload = await new Promise<SignalingPayload>(
          (resolve, reject) => {
            answerResolverRef.current = resolve;
            answerRejectRef.current = reject;

            // An answer that beat this promise into existence.
            const early = pendingAnswerRef.current;
            pendingAnswerRef.current = null;
            if (early) void submitAnswer(early);

            // Check periodically if cancelled
            const checkInterval = setInterval(() => {
              if (cancelledRef.current) {
                clearInterval(checkInterval);
                reject(new Error('Cancelled'));
              }
            }, 500);
          },
        );

        // The answer is in hand; the watch has nothing left to do. The pool
        // stays up so the background sweep runs on behind the P2P transfer,
        // as it does behind a Nostr one; the final teardown ends it.
        closeAnswerWatch();

        if (cancelledRef.current) return;

        // Enforce TTL: refuse to proceed with old answers/offers
        if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
          throw new Error('Session expired. Please start a new transfer.');
        }

        // Derive shared secret from receiver's public key
        setState({
          status: 'connecting',
          message: 'Establishing secure connection...',
        });

        if (!ecdhPrivateKeyRef.current || !saltRef.current) {
          throw new Error('Cryptographic state missing. Please try again.');
        }

        const receiverPublicKey = new Uint8Array(answerPayload.publicKey!);
        // Derive shared secret as non-extractable CryptoKey. It outlives the
        // content key: the relay fallback derives its session from it.
        const sharedSecretKey = await deriveSharedSecretKey(
          ecdhPrivateKeyRef.current,
          receiverPublicKey,
        );
        const key = await deriveAESKeyFromSecretKey(
          sharedSecretKey,
          saltRef.current,
        );

        // Clear ECDH private key - no longer needed
        ecdhPrivateKeyRef.current = null;

        // Handle answer signal
        await rtc.handleSignal({ type: 'answer', sdp: answerPayload.sdp });

        // Add ICE candidates from answer
        for (const candidateStr of answerPayload.candidates) {
          await rtc.handleSignal({
            type: 'candidate',
            candidate: {
              candidate: candidateStr,
              sdpMid: '0',
              sdpMLineIndex: 0,
            },
          });
        }

        // Wait for data channel to open. When no direct route exists and the
        // offer named relays, the file goes through them instead (see
        // relayFallback); without relays, or past the relay size cap, the
        // failure stands as it always did.
        try {
          await waitForDataChannel(
            rtc,
            answerRelays.length > 0
              ? RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS
              : MANUAL_CONNECTION_TIMEOUT_MS,
          );
        } catch (error) {
          if (
            !(error instanceof P2PConnectionError) ||
            storageRelays === null ||
            cancelledRef.current
          ) {
            throw error;
          }
          if (content.estimatedSize > NOSTR_FILE_MAX_BYTES) {
            throw new P2PConnectionError(
              `${error.message}. The file is over ${formatFileSize(NOSTR_FILE_MAX_BYTES)}, so it cannot be relayed through Nostr either.`,
            );
          }
          rtc.close();
          rtcRef.current = null;
          await relayFallback(storageRelays);
          return;
        }

        if (cancelledRef.current) return;

        // Enforce TTL again right before data transfer begins
        if (Date.now() - sessionStartTime > TRANSFER_EXPIRATION_MS) {
          throw new Error('Session expired. Please start a new transfer.');
        }

        // Send data via P2P (WebRTC DTLS provides transport encryption)
        setState({
          status: 'transferring',
          message: 'Sending via P2P...',
          progress: { current: 0, total: fileSize },
          contentType: 'file',
          fileMetadata: { fileName, fileSize, mimeType },
        });

        // Send data in encrypted chunks and wait for the receiver's ACK.
        await sendFileOverDataChannel(rtc, key, content, {
          onProgress: (current, total) =>
            setState({
              status: 'transferring',
              message: 'Sending via P2P...',
              progress: { current, total },
              contentType: 'file',
              fileMetadata: { fileName, fileSize, mimeType },
            }),
          isCancelled: () => cancelledRef.current,
        });

        setState({
          status: 'complete',
          message: 'File sent via P2P!',
          contentType: 'file',
        });

        /**
         * The relay data path: the session both sides derive from the ECDH
         * secret keys the transfer, the offer's answer relays carry its
         * control channel, and the storage ring prepared behind the exchange
         * holds the pieces. Only now is the file read, hashed, and uploaded —
         * nothing was staged while a direct connection was still possible.
         */
        async function relayFallback(
          storageRelays: PreparedStorageRelays,
        ): Promise<void> {
          relayFallbackActive = true;
          const fileMetadata = { fileName, fileSize, mimeType };
          const relayState = {
            contentType: 'file' as const,
            fileMetadata,
            currentRelays: answerRelays,
          };
          setState({
            status: 'preparing',
            message: `${RELAY_FALLBACK_MESSAGE}. Reading file...`,
            ...relayState,
          });
          const isCancelled = () => cancelledRef.current;
          const data = await readSourceFully(content, isCancelled);
          if (data.length === 0) throw new Error('File is empty');
          if (cancelledRef.current) return;
          if (!saltRef.current) {
            throw new Error('Cryptographic state missing. Please try again.');
          }
          const session = await deriveRelaySession(
            sharedSecretKey,
            saltRef.current,
          );
          const relayFileSize = data.length;
          let lastStats: NostrFileTransferStats | undefined;
          try {
            await sendFileLive(
              data,
              { fileName, mimeType, precompressed: content.precompressed },
              {
                pool,
                session,
                controlRelays: answerRelays,
                storageRelays,
                isCancelled,
                onProgress: (p) => {
                  if (cancelledRef.current) return;
                  lastStats = p.stats;
                  switch (p.phase) {
                    case 'hashing':
                      setState({
                        status: 'preparing',
                        message: `${RELAY_FALLBACK_MESSAGE}. Encrypting file...`,
                        ...relayState,
                        stats: p.stats,
                      });
                      break;
                    case 'transfer': {
                      const chunksDone = p.chunksDone ?? 0;
                      const chunksTotal = p.chunksTotal ?? 1;
                      const have = p.receiverHave ?? 0;
                      let message: string;
                      if (!p.receiverConnected) {
                        message =
                          chunksDone === chunksTotal
                            ? 'All pieces uploaded to relays. Waiting for the receiver...'
                            : `Uploading pieces to relays (${chunksDone}/${chunksTotal})... waiting for the receiver.`;
                      } else if (have >= chunksTotal) {
                        message = 'Receiver has every piece — verifying...';
                      } else {
                        message = `Relaying through Nostr — receiver has ${have}/${chunksTotal} pieces (uploaded ${chunksDone}/${chunksTotal}${
                          p.resent ? `, re-sent ${p.resent}` : ''
                        }).`;
                      }
                      setState({
                        status: 'uploading',
                        message,
                        progress: {
                          current: Math.min(
                            have *
                              chunkBytesEstimate(relayFileSize, chunksTotal),
                            relayFileSize,
                          ),
                          total: relayFileSize,
                        },
                        ...relayState,
                        stats: p.stats,
                      });
                      break;
                    }
                  }
                },
              },
            );
          } catch (error) {
            if (error instanceof NostrFileCancelledError) return;
            throw error;
          }
          if (cancelledRef.current) return;
          setState({
            status: 'complete',
            message: 'File sent through Nostr relays!',
            contentType: 'file',
            fileMetadata,
            stats: lastStats,
          });
        }

        async function waitForDataChannel(
          rtc: WebRTCConnection,
          timeoutMs: number,
        ) {
          await new Promise<void>((resolve, reject) => {
            const pc = rtc.getPeerConnection();
            const dc = rtc.getDataChannel();
            const timeout = setTimeout(() => {
              cleanup();
              reject(new P2PConnectionError('Connection timeout'));
            }, timeoutMs);

            const cleanup = () => {
              clearTimeout(timeout);
              pc.onconnectionstatechange = null;
              if (dc) {
                dc.onopen = null;
              }
            };

            const checkConnection = () => {
              if (pc.connectionState === 'connected') {
                const currentDc = rtc.getDataChannel();
                if (currentDc && currentDc.readyState === 'open') {
                  cleanup();
                  resolve();
                }
              } else if (
                pc.connectionState === 'failed' ||
                pc.connectionState === 'disconnected'
              ) {
                cleanup();
                reject(new P2PConnectionError('Connection failed'));
              }
            };

            pc.onconnectionstatechange = checkConnection;
            if (dc) {
              dc.onopen = () => {
                cleanup();
                resolve();
              };
            }
            checkConnection();
          });
        }
      } catch (error) {
        if (!cancelledRef.current) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Failed to send',
            connectionFailed: error instanceof P2PConnectionError,
          });
        }
      } finally {
        clearExpirationTimeout();
        teardownAnswerRelay();
        pendingAnswerRef.current = null;
        sendingRef.current = false;
        answerResolverRef.current = null;
        answerRejectRef.current = null;
        ecdhPrivateKeyRef.current = null;
        saltRef.current = null;
        if (rtcRef.current) {
          rtcRef.current.close();
          rtcRef.current = null;
        }
      }
    },
    [
      clearExpirationTimeout,
      closeAnswerWatch,
      submitAnswer,
      teardownAnswerRelay,
    ],
  );

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, send, submitAnswer, cancel }),
    [state, send, submitAnswer, cancel],
  );
}
