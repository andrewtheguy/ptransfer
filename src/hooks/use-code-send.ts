import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeAnswerTranscriptHash,
  computeOfferTranscriptHash,
  decodeAnswerConfirmation,
  generateMutualOfferBinary,
  parseMutualPayload,
  type SignalingPayload,
} from '@/lib/code-signaling';
import {
  constantTimeEqualBytes,
  deriveAESKeyFromSecretKey,
  deriveAnswerConfirmation,
  deriveSharedSecretKey,
  generateECDHKeyPair,
  generateSalt,
  MAX_MESSAGE_SIZE,
  SLOW_TRANSPORT_MAX_BYTES,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto';
import { wipeBufferSource } from '@/lib/crypto/memory';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferMetadata } from '@/lib/nostr';
import {
  ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS,
  AnonymousSignalingTransport,
} from '@/lib/nostr/anonymous-transport';
import { ANONYMOUS_SIGNALING_RELAYS } from '@/lib/nostr/relays';
import { watchForReceiverHello } from '@/lib/nostr-file/hello-watch';
import { createIndexedDbRelayPool } from '@/lib/nostr-file/relay-pool';
import {
  deriveRelaySession,
  type RelaySession,
} from '@/lib/nostr-file/session';
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
import {
  createDataChannelTransport,
  sendFileOverTransport,
} from '@/lib/p2p-transfer';
import type { TorBridge } from '@/lib/tor/client';
import {
  deriveOnionPassword,
  serveOverAnonymousRelay,
} from '@/lib/tor/code-relay';
import { TOR_MAX_WIRE_BYTES } from '@/lib/tor/transfer';
import { type TransferSource, wireEncodingFor } from '@/lib/transfer-source';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';
import { chunkBytesEstimate, readSourceFully } from './nostr-relay-source';

// Extended transfer status for Code Exchange
export type CodeTransferStatus =
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
  // The anonymous fallback holds its onion service open for a receiver that
  // has to build a rendezvous circuit to reach it.
  | 'waiting_for_receiver'
  | 'complete'
  | 'error';

// Base properties for Code Exchange transfer state
interface CodeTransferStateBase {
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
  // Set on an error state when a direct P2P connection could not be established;
  // drives the offline-QR fallback suggestion in the UI.
  connectionFailed?: boolean;
  /** Relay fallback: running totals for the relay transfer. */
  stats?: NostrFileTransferStats;
}

// Error state has required message
interface CodeTransferStateError extends CodeTransferStateBase {
  status: 'error';
  message: string;
}

// All other states have optional message
interface CodeTransferStateOther extends CodeTransferStateBase {
  status: Exclude<CodeTransferStatus, 'error'>;
  message?: string;
}

// Discriminated union for Code Exchange transfer state
export type CodeTransferState = CodeTransferStateError | CodeTransferStateOther;

export interface CodeSendOptions {
  /**
   * Run the fallback inside Tor rather than on the clearnet: the control
   * channel on the onion relay pool, the file over an onion service this tab
   * publishes. The offer records it, so the receiving page follows.
   */
  anonymousRelay: boolean;
  /** Which Snowflake bridge to reach Tor through. Ignored otherwise. */
  bridge: TorBridge;
}

export interface UseCodeSendReturn {
  state: CodeTransferState;
  send: (content: TransferSource, options: CodeSendOptions) => Promise<void>;
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
  probing_defaults: 'Checking relays for the fallback...',
  discovering: 'Looking for more storage relays to back them up...',
  probing_discovered: 'Testing the storage relays we found...',
};
const CODE_CONNECTION_TIMEOUT_MS = 120000;
// When a relay fallback is available, the direct attempt is capped well below
// the full timeout: the offerer keeps real candidates to try against the
// receiver's unreachable ones, so its ICE agent is slow to declare failure,
// while the receiver (with no viable candidates) has already given up. A
// direct connection that is going to work opens in a few seconds; if none has
// after this window, relay it rather than ride out the full backstop.
const RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS = 20000;
const RELAY_FALLBACK_MESSAGE =
  'No direct connection — relaying the file through Nostr instead';
const TOR_FALLBACK_MESSAGE =
  'No direct connection — relaying the file through Tor instead';

export function useCodeSend(): UseCodeSendReturn {
  const [state, setState] = useState<CodeTransferState>({ status: 'idle' });

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

  // Relay pool behind the exchange: proves the relays the offer names and,
  // if the direct connection fails, carries the file.
  const poolRef = useRef<ReturnType<typeof createTransferPool> | null>(null);
  // Storage-ring preparation and the relay enumeration running on behind
  // the exchange; aborted with the pool so a teardown never waits out a
  // probe, and never records its own teardown as relay failures.
  const sweepAbortRef = useRef<AbortController | null>(null);
  // The Tor client behind an anonymous fallback, and the socket adapter the
  // pool above is built on. Null for a clearnet transfer, which never loads
  // one. Closing it takes the bootstrap, every relay socket, and every
  // circuit with it.
  const transportRef = useRef<AnonymousSignalingTransport | null>(null);

  const teardownRelayPool = useCallback(() => {
    sweepAbortRef.current?.abort();
    sweepAbortRef.current = null;
    poolRef.current?.destroy();
    poolRef.current = null;
    const transport = transportRef.current;
    transportRef.current = null;
    transport?.close();
  }, []);

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
    teardownRelayPool();
    answerResolverRef.current = null;
    answerRejectRef.current = null;
    ecdhPrivateKeyRef.current = null;
    saltRef.current = null;
    if (rtcRef.current) {
      rtcRef.current.close();
      rtcRef.current = null;
    }
    setState({ status: 'idle' });
  }, [clearExpirationTimeout, teardownRelayPool]);

  // Navigating away ends the transfer, as it does in the Tor modes: nothing
  // reaches this hook once it is gone, and an anonymous fallback left running
  // would hold a Tor client, its circuits, and an onion service until the
  // session expired.
  useEffect(() => () => cancel(), [cancel]);

  // The scanned or pasted answer lands here; the sender's explicit action is
  // the only way an answer ever enters the flow.
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
    async (content: TransferSource, options: CodeSendOptions) => {
      // Guard against concurrent invocations
      if (sendingRef.current) return;
      sendingRef.current = true;
      cancelledRef.current = false;
      // Decides both halves of the fallback at once, and nothing else: the
      // exchange, the direct attempt and the code itself are the same either
      // way. Read once here so no branch below can disagree with the offer.
      const anonymous = options.anonymousRelay;

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

        // The Tor transport's wire allowance, checked before a code is made
        // rather than after a bootstrap and a handshake. A ZIP's headers and
        // entry paths are wire bytes no file size accounts for, so a selection
        // of many tiny files can pass the checks above and still not fit.
        if (anonymous && content.projectedWireBytes > TOR_MAX_WIRE_BYTES) {
          setState({
            status: 'error',
            message: `This selection needs up to ${formatFileSize(content.projectedWireBytes)} on the wire, over the ${formatFileSize(TOR_MAX_WIRE_BYTES)} the Tor transport allows. Archive overhead grows with the number of files; send fewer of them.`,
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

        // Resolve the relays the offer will name (the control relays of the
        // file-relay fallback) while WebRTC creates the offer and gathers
        // candidates, so the probe of the defaults costs no extra wait.
        // Robustness matches the storage transfer: the defaults are
        // control-probed, and a defunct default is replaced by a
        // full-size-proven discovered relay, not a weaker control-sized
        // discovery — so a discovery pass may run (probing only until the
        // gap is filled) and can outlast ICE gathering, which is reported
        // and waited out. A failure or a set
        // below the floor is caught: the offer simply goes out without
        // relays, and a failed direct connection then has no fallback.
        teardownRelayPool();
        // The anonymous fallback answers both questions this block otherwise
        // spends the exchange on. Its control relays are a constant both sides
        // hold, so there is nothing to prove or discover; what it needs
        // instead is a Tor client, and that is minutes rather than seconds.
        // Starting the bootstrap here — behind the exchange, exactly where the
        // clearnet path runs its relay probe — is what keeps the fallback from
        // beginning one only once the direct route is known to be dead.
        // Bootstrapping publishes nothing: the onion service is established
        // after the response is accepted, and not before.
        let transport: AnonymousSignalingTransport | null = null;
        // The Tor client's own progress, which has no place on screen while
        // the code is showing: the sender is looking at a QR, and a transfer
        // that connects directly never needed the client at all. Once the
        // fallback is waiting on the bootstrap it is the only progress there
        // is, so from that point it becomes the transfer's own — a cold start
        // is minutes, and one frozen line for all of them reads as a hang.
        let torStatus = '';
        let torFallbackActive = false;
        if (anonymous) {
          transport = new AnonymousSignalingTransport({
            bridge: options.bridge,
            onStatus: (message) => {
              torStatus = message;
              console.info('[tor] Code Exchange fallback:', message);
              if (!torFallbackActive || cancelledRef.current) return;
              setState({
                status: 'connecting',
                message: `${TOR_FALLBACK_MESSAGE}. ${message}`,
                contentType: 'file',
                fileMetadata: { fileName, fileSize, mimeType },
              });
            },
          });
          transportRef.current = transport;
        }
        const pool = createTransferPool(
          transport
            ? {
                websocketImplementation: transport.websocketImplementation,
                connectionTimeoutMs: ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS,
              }
            : {},
        );
        poolRef.current = pool;
        const relayStorage = anonymous ? null : createIndexedDbRelayPool();
        const relayStats = createTransferStats('sender');
        let relayPhase: RelayResolvePhase = 'probing_defaults';
        let relayDone = anonymous;
        let awaitingRelays = false;
        const showRelayPhase = () => {
          if (!awaitingRelays || cancelledRef.current) return;
          setState({
            status: 'generating_offer',
            message: RELAY_PHASE_MESSAGES[relayPhase],
          });
        };
        const relayProbe: Promise<TransferRelaySelection | null> = relayStorage
          ? resolveTransferRelays(pool, relayStorage, {
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
              })
          : Promise.resolve(null);

        // Set expiration timeout
        clearExpirationTimeout();
        expirationTimeoutRef.current = setTimeout(() => {
          if (!cancelledRef.current && sendingRef.current) {
            cancelledRef.current = true;
            setState({
              status: 'error',
              message: 'Session expired. Please try again.',
            });
            answerRejectRef.current?.(
              new Error('Session expired. Please try again.'),
            );
            answerResolverRef.current = null;
            teardownRelayPool();
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
        const offerRelays = selection?.controlRelays ?? [];
        // Set once the direct attempt has failed: from then on the storage
        // preparation's progress is the transfer's progress.
        let relayFallbackActive = false;
        let storageRelays: PreparedStorageRelays | null = null;
        if (relayStorage && selection && offerRelays.length > 0) {
          // The control relays are settled; the storage ring is prepared in
          // the background on the same pool and relay cache — the offer's QR
          // does not depend on it. When control resolution already had to
          // discover candidates to backfill a defunct default, the ring is
          // probed from what it left unprobed instead of discovering again;
          // otherwise discovery runs here. Either way the sweep then keeps
          // probing the rest of the population for as long as the exchange
          // lasts, warming the shared cache and handing a failed direct
          // attempt its ring ready-made. It ends with the pool.
          const sweepAbort = new AbortController();
          sweepAbortRef.current = sweepAbort;
          storageRelays = prepareStorageRelays(pool, {
            controlRelays: offerRelays,
            storage: relayStorage,
            stats: selection.stats,
            discovered: selection.discovered,
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
                currentRelays: offerRelays,
                stats: p.stats,
              });
            },
          });
        } else if (!anonymous) {
          teardownRelayPool();
        }

        // Which relays carry the fallback's control channel, or null when
        // there is no fallback at all. The anonymous pool needs no proving:
        // it is a constant on both sides, and an offer that asked for it
        // names no relays precisely because there is nothing to name.
        const fallbackRelays: string[] | null = anonymous
          ? [...ANONYMOUS_SIGNALING_RELAYS]
          : storageRelays !== null
            ? offerRelays
            : null;

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
            ...(anonymous
              ? { anonymous: true }
              : storageRelays
                ? { relays: offerRelays }
                : {}),
          },
        );

        if (cancelledRef.current) return;

        // Show offer and wait for answer
        setState({
          status: 'showing_offer',
          message: 'Show this to receiver, then scan/paste their response',
          offerData: offerBinary,
          contentType: 'file',
          fileMetadata: { fileName, fileSize, mimeType },
        });

        // Wait for answer to be submitted
        const answerPayload = await new Promise<SignalingPayload>(
          (resolve, reject) => {
            let checkInterval: ReturnType<typeof setInterval> | null = null;
            const cleanup = () => {
              if (checkInterval !== null) clearInterval(checkInterval);
              checkInterval = null;
            };
            const resolveAnswer = (payload: SignalingPayload) => {
              cleanup();
              resolve(payload);
            };
            const rejectAnswer = (error: Error) => {
              cleanup();
              reject(error);
            };

            answerResolverRef.current = resolveAnswer;
            answerRejectRef.current = rejectAnswer;

            // Check periodically if cancelled
            checkInterval = setInterval(() => {
              if (cancelledRef.current) {
                rejectAnswer(new Error('Cancelled'));
              }
            }, 500);
          },
        );

        // The answer is in hand. The pool stays up so the background sweep
        // runs on behind the P2P transfer, as it does behind a Nostr one; the
        // final teardown ends it.
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

        // Key confirmation before anything in the answer is acted on. The tag
        // is keyed by the shared secret just derived and bound to both this
        // offer and the answer's own contents, so only a peer that read this
        // offer and completed the same agreement can produce one, and only
        // for the answer it actually sent: an answer meant for another
        // transfer, a replayed answer, and one whose SDP or candidates were
        // altered on the way back all fail here instead of surfacing later as
        // a connection that never opens. The offer stays the only secret
        // gating the transfer — this does not make an offer captured off the
        // screen harmless.
        const expectedConfirmation = await deriveAnswerConfirmation(
          sharedSecretKey,
          saltRef.current,
          {
            offerTranscriptHash: await computeOfferTranscriptHash(offerBinary),
            answerTranscriptHash:
              await computeAnswerTranscriptHash(answerPayload),
          },
        );
        const presentedConfirmation = decodeAnswerConfirmation(
          answerPayload.confirm,
        );
        if (
          !presentedConfirmation ||
          !constantTimeEqualBytes(presentedConfirmation, expectedConfirmation)
        ) {
          throw new Error(
            'Response does not match this transfer. Make sure you scanned the response to this code, then try again.',
          );
        }

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
        //
        // With a fallback available, the relay session is derived now and
        // the control relays are watched for the receiver's `hello` while
        // the direct attempt runs: the receiver gives up on the direct route
        // long before this side's ICE agent does, and its hello — sealed
        // under the session key only it and this side hold — is the earliest
        // word that the file has to go through relays.
        let relaySession: RelaySession | null = null;
        let helloWatch: ReturnType<typeof watchForReceiverHello> | null = null;
        if (fallbackRelays !== null) {
          relaySession = await deriveRelaySession(
            sharedSecretKey,
            saltRef.current,
          );
          if (cancelledRef.current) {
            wipeBufferSource(relaySession.keyBytes);
            return;
          }
          helloWatch = watchForReceiverHello(
            pool,
            fallbackRelays,
            relaySession,
            {
              since: Math.floor(sessionStartTime / 1000),
              expiresAt: Math.floor(
                (sessionStartTime + TRANSFER_EXPIRATION_MS) / 1000,
              ),
              ...(storageRelays ? { stats: storageRelays.stats } : {}),
            },
          );
        }
        try {
          await waitForDataChannel(
            rtc,
            fallbackRelays !== null
              ? RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS
              : CODE_CONNECTION_TIMEOUT_MS,
            helloWatch?.hello ?? null,
          );
        } catch (error) {
          if (
            !(error instanceof P2PConnectionError) ||
            fallbackRelays === null ||
            relaySession === null ||
            cancelledRef.current
          ) {
            if (relaySession) wipeBufferSource(relaySession.keyBytes);
            throw error;
          }
          if (content.estimatedSize > SLOW_TRANSPORT_MAX_BYTES) {
            wipeBufferSource(relaySession.keyBytes);
            throw new P2PConnectionError(
              `${error.message}. The file is over ${formatFileSize(SLOW_TRANSPORT_MAX_BYTES)}, so it cannot be relayed through ${anonymous ? 'Tor' : 'Nostr'} either.`,
            );
          }
          rtc.close();
          rtcRef.current = null;
          if (transport) {
            await anonymousFallback(fallbackRelays, relaySession, transport);
          } else if (storageRelays) {
            await relayFallback(storageRelays, relaySession);
          }
          return;
        } finally {
          helloWatch?.close();
        }
        // The direct route opened; the relay session is not needed.
        if (relaySession) wipeBufferSource(relaySession.keyBytes);

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
        await sendFileOverTransport(
          createDataChannelTransport(rtc),
          key,
          content,
          {
            onProgress: (current, total) =>
              setState({
                status: 'transferring',
                message: 'Sending via P2P...',
                progress: { current, total },
                contentType: 'file',
                fileMetadata: { fileName, fileSize, mimeType },
              }),
            isCancelled: () => cancelledRef.current,
          },
        );

        setState({
          status: 'complete',
          message: 'File sent via P2P!',
          contentType: 'file',
        });

        /**
         * The anonymous relay data path: the same session keys an encrypted
         * control channel on the onion relay pool, and the file goes over a
         * v3 onion service this tab publishes rather than to storage relays.
         *
         * Neither of the two values the Tor transport normally asks a person
         * for is handed over: the password comes out of the ECDH secret on
         * both sides, and the address — which cannot be derived — is announced
         * on that control channel. Both happen here, after the response was
         * accepted and verified, which is what keeps the service unreachable
         * until the sender took that response in. See lib/tor/code-relay.ts.
         */
        async function anonymousFallback(
          relays: string[],
          session: RelaySession,
          transport: AnonymousSignalingTransport,
        ): Promise<void> {
          const fileMetadata = { fileName, fileSize, mimeType };
          const relayState = {
            contentType: 'file' as const,
            fileMetadata,
            currentRelays: relays,
          };
          setState({
            status: 'connecting',
            message: `${TOR_FALLBACK_MESSAGE}. ${
              torStatus || 'Starting the Tor client...'
            }`,
            ...relayState,
          });
          // The bootstrap has been running behind the exchange; this is only
          // the wait for whatever is left of it, and its own progress is the
          // transfer's now that there is nothing else on screen.
          torFallbackActive = true;
          let client: Awaited<ReturnType<typeof transport.torClient>>;
          try {
            client = await transport.torClient();
          } catch (error) {
            // A bootstrap that never finished handed the session on to
            // nothing, so these bytes die here rather than riding the throw
            // out to a catch that only reports it.
            wipeBufferSource(session.keyBytes);
            throw error;
          } finally {
            torFallbackActive = false;
          }
          if (cancelledRef.current) {
            wipeBufferSource(session.keyBytes);
            return;
          }

          try {
            await serveOverAnonymousRelay({
              client,
              pool,
              relays,
              session,
              since: Math.floor(sessionStartTime / 1000),
              expiresAt: Math.floor(
                (sessionStartTime + TRANSFER_EXPIRATION_MS) / 1000,
              ),
              password: await deriveOnionPassword(sharedSecretKey, salt),
              content,
              metadata: {
                contentType: 'file',
                fileName,
                fileSize,
                contentEncoding,
                mimeType,
              } satisfies TransferMetadata,
              fileMetadata,
              isCancelled: () => cancelledRef.current,
              onStatus: (message) => {
                if (cancelledRef.current) return;
                setState({
                  status: 'waiting_for_receiver',
                  message: `${TOR_FALLBACK_MESSAGE}. ${message}`,
                  ...relayState,
                });
              },
              onProgress: (current, total, message) => {
                if (cancelledRef.current) return;
                setState({
                  status: 'uploading',
                  message,
                  progress: { current, total },
                  ...relayState,
                });
              },
            });
          } finally {
            // Nothing downstream took ownership of these: the control key was
            // derived from them and the file key came from the handshake.
            wipeBufferSource(session.keyBytes);
          }

          if (cancelledRef.current) return;
          setState({
            status: 'complete',
            message: 'File sent through Tor!',
            contentType: 'file',
            fileMetadata,
          });
        }

        /**
         * The relay data path: the session both sides derive from the ECDH
         * secret keys the transfer, the relays the offer named carry its
         * control channel, and the storage ring prepared behind the exchange
         * holds the pieces. Only now is the file read, hashed, and uploaded —
         * nothing was staged while a direct connection was still possible.
         */
        async function relayFallback(
          storageRelays: PreparedStorageRelays,
          session: RelaySession,
        ): Promise<void> {
          relayFallbackActive = true;
          const fileMetadata = { fileName, fileSize, mimeType };
          const relayState = {
            contentType: 'file' as const,
            fileMetadata,
            currentRelays: offerRelays,
          };
          setState({
            status: 'preparing',
            message: `${RELAY_FALLBACK_MESSAGE}. Reading file...`,
            ...relayState,
          });
          const isCancelled = () => cancelledRef.current;
          // `session.keyBytes` belong to sendFileLive once it runs; until
          // then every exit wipes them here.
          let data: Uint8Array;
          try {
            data = await readSourceFully(content, isCancelled);
          } catch (error) {
            wipeBufferSource(session.keyBytes);
            throw error;
          }
          if (data.length === 0 || cancelledRef.current) {
            wipeBufferSource(session.keyBytes);
            if (cancelledRef.current) return;
            throw new Error('File is empty');
          }
          const relayFileSize = data.length;
          let lastStats: NostrFileTransferStats | undefined;
          try {
            await sendFileLive(
              data,
              { fileName, mimeType, precompressed: content.precompressed },
              {
                pool,
                session,
                controlRelays: offerRelays,
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

        /**
         * Resolve when the data channel opens; reject on ICE failure, on
         * the timeout, or as soon as `receiverGaveUp` settles (the receiver
         * has reported over the relays that no direct route exists).
         */
        async function waitForDataChannel(
          rtc: WebRTCConnection,
          timeoutMs: number,
          receiverGaveUp: Promise<void> | null,
        ) {
          await new Promise<void>((resolve, reject) => {
            const pc = rtc.getPeerConnection();
            const dc = rtc.getDataChannel();
            const timeout = setTimeout(() => {
              cleanup();
              reject(new P2PConnectionError('Connection timeout'));
            }, timeoutMs);
            let settled = false;
            receiverGaveUp?.then(
              () => {
                if (settled) return;
                cleanup();
                reject(
                  new P2PConnectionError(
                    'The receiver reports no direct connection is possible',
                  ),
                );
              },
              () => {
                // A failed hello watch only disables this early-exit signal;
                // ICE failure and the connection timeout remain authoritative.
              },
            );

            const cleanup = () => {
              settled = true;
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
        teardownRelayPool();
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
    [clearExpirationTimeout, teardownRelayPool],
  );

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, send, submitAnswer, cancel }),
    [state, send, submitAnswer, cancel],
  );
}
