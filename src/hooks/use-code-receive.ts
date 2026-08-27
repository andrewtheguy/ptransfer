import { useCallback, useRef, useState } from 'react';
import {
  computeOfferTranscriptHash,
  generateMutualAnswerBinary,
  parseMutualPayload,
  relaysFromOffer,
  type SignalingPayload,
} from '@/lib/code-signaling';
import {
  deriveAESKeyFromSecretKey,
  deriveAnswerConfirmation,
  deriveSharedSecretKey,
  generateECDHKeyPair,
  MAX_MESSAGE_SIZE,
  SLOW_TRANSPORT_MAX_BYTES,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferState } from '@/lib/nostr';
import { receiveFileLive } from '@/lib/nostr-file/download-live';
import { deriveRelaySession } from '@/lib/nostr-file/session';
import { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import { NostrFileCancelledError } from '@/lib/nostr-file/upload';
import { ACK, createTransferReceiver } from '@/lib/p2p-transfer';
import { createPendingStep, type PendingStep } from '@/lib/pending-step';
import { type AppendSink, createAdaptiveAppendSink } from '@/lib/scratch-sink';
import type { ReceivedContent } from '@/lib/types';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';

// Extended transfer status for Code Exchange receive mode
export type CodeReceiveStatus =
  | 'idle'
  | 'waiting_for_offer'
  | 'generating_answer'
  | 'showing_answer'
  | 'connecting'
  | 'receiving'
  // Relay fallback after a failed direct connection.
  | 'fetching'
  | 'complete'
  | 'error';

// Typed Code Exchange receive state for UI consumers.
export interface CodeReceiveState {
  status: CodeReceiveStatus;
  message?: string;
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
  answerData?: Uint8Array; // Binary data for QR code
}

/**
 * An accepted offer, plus the digest of the container it arrived in. The
 * digest is what the answer's confirmation tag is bound to, so it has to be
 * taken from the bytes the receiver was handed rather than recomputed from
 * the parsed payload later.
 */
interface IncomingOffer {
  payload: SignalingPayload;
  transcriptHash: string;
}

export interface UseCodeReceiveReturn {
  state: TransferState & CodeReceiveState;
  receivedContent: ReceivedContent | null;
  startReceive: () => void;
  submitOffer: (offerData: Uint8Array) => void;
  cancel: () => void;
  reset: () => void;
}

const ICE_GATHER_TIMEOUT_MS = 5000;
const CODE_CONNECTION_TIMEOUT_MS = 120000;
// Matches the sender: once a relay fallback is available, cap the direct
// attempt so neither side rides out the full backstop before relaying.
const RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS = 20000;
const RELAY_FALLBACK_MESSAGE =
  'No direct connection — receiving the file through Nostr instead';

export function useCodeReceive(): UseCodeReceiveReturn {
  const [state, setState] = useState<TransferState & CodeReceiveState>({
    status: 'idle',
  });
  const [receivedContent, setReceivedContent] =
    useState<ReceivedContent | null>(null);

  const rtcRef = useRef<WebRTCConnection | null>(null);
  const cancelledRef = useRef(false);
  const receivingRef = useRef(false);
  // Storage backing the in-flight or completed transfer. Discarded whenever
  // the payload it backs is abandoned; kept after completion because
  // receivedContent.data reads from it until reset.
  const sinkRef = useRef<AppendSink | null>(null);
  // Pool carrying the relay transfer after a failed direct connection.
  // Cancel reaches it through this ref so an abandoned receive stops talking
  // to relays instead of finishing the round on a dead session.
  const relayPoolRef = useRef<ReturnType<typeof createTransferPool> | null>(
    null,
  );

  // The step a receive blocks on until the UI settles it. Cancel rejects it
  // while pending so the flow unwinds immediately.
  const offerStepRef = useRef<PendingStep<IncomingOffer> | null>(null);
  // Identifies the receive currently in charge of the refs. A cancelled run
  // that is still unwinding compares against it before touching shared
  // state, so a restart right after cancel is never clobbered.
  const runRef = useRef(0);

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
    const relayPool = relayPoolRef.current;
    relayPoolRef.current = null;
    if (relayPool) relayPool.destroy();
    receivingRef.current = false;
    const offerStep = offerStepRef.current;
    offerStepRef.current = null;
    offerStep?.reject(new Error('Cancelled'));
    if (rtcRef.current) {
      rtcRef.current.close();
      rtcRef.current = null;
    }
    setState({ status: 'idle' });
  }, [discardSink]);

  const reset = useCallback(() => {
    cancel();
    discardSink();
    setReceivedContent(null);
  }, [cancel, discardSink]);

  const submitOffer = useCallback(async (offerData: Uint8Array) => {
    const step = offerStepRef.current;
    if (!step) return;

    // Parse mutual payload (no decryption needed)
    const parsed = await parseMutualPayload(offerData);
    // The step may have been cancelled while parsing; settle-once makes the
    // calls below harmless then, but don't clear a newer run's step.
    if (offerStepRef.current === step) offerStepRef.current = null;
    if (!parsed) {
      step.reject(new Error('Invalid offer format'));
      return;
    }
    if (parsed.type !== 'offer') {
      step.reject(new Error('Expected offer, got answer'));
      return;
    }
    // Hash the container as it arrived, before anything downstream can
    // reshape it; the answer's confirmation tag is bound to this exact value.
    step.resolve({
      payload: parsed,
      transcriptHash: await computeOfferTranscriptHash(offerData),
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: doReceive is defined below and only invoked at call time; references stable refs/setState
  const startReceive = useCallback(() => {
    // Guard against concurrent invocations
    if (receivingRef.current) return;
    receivingRef.current = true;
    cancelledRef.current = false;
    setReceivedContent(null);
    // The previous transfer's payload (if any) is gone from the UI now.
    discardSink();

    // Start the receive flow
    void doReceive();
  }, []);

  const doReceive = async () => {
    const run = ++runRef.current;
    // Cancelled, or superseded by a receive started after the cancel — in
    // either case this closure must stop and leave the shared refs alone.
    const abandoned = () => cancelledRef.current || runRef.current !== run;
    try {
      // Show input for scanning/pasting offer
      setState({
        status: 'waiting_for_offer',
        message: "Scan or paste the sender's code",
      });

      // Wait for offer to be submitted
      const offerStep = createPendingStep<IncomingOffer>();
      offerStepRef.current = offerStep;
      const { payload: offerPayload, transcriptHash: offerTranscriptHash } =
        await offerStep.promise;

      if (abandoned()) return;

      // Enforce TTL
      if (
        typeof offerPayload.createdAt !== 'number' ||
        !Number.isFinite(offerPayload.createdAt)
      ) {
        setState({
          status: 'error',
          message: 'Offer missing timestamp. Ask sender to create a new one.',
        });
        return;
      }
      if (Date.now() - offerPayload.createdAt > TRANSFER_EXPIRATION_MS) {
        setState({
          status: 'error',
          message: 'Offer expired. Ask sender to create a new one.',
        });
        return;
      }

      // Extract metadata from offer
      const {
        fileName,
        fileSize,
        contentEncoding,
        mimeType,
        salt: saltArray,
        publicKey: senderPublicKeyArray,
      } = offerPayload;

      // Validate required fields
      if (!saltArray) {
        setState({
          status: 'error',
          message: 'Invalid offer: missing encryption salt',
        });
        return;
      }

      // Validate required metadata
      if (
        !fileName ||
        !mimeType ||
        typeof fileSize !== 'number' ||
        !Number.isFinite(fileSize) ||
        fileSize < 0 ||
        (contentEncoding !== 'deflate-raw' && contentEncoding !== 'identity')
      ) {
        setState({
          status: 'error',
          message: 'Invalid offer: missing or invalid file metadata',
        });
        return;
      }

      // Security check: Enforce MAX_MESSAGE_SIZE
      if (fileSize > MAX_MESSAGE_SIZE) {
        setState({
          status: 'error',
          message: `Transfer rejected: Size (${formatFileSize(fileSize)}) exceeds limit (${formatFileSize(MAX_MESSAGE_SIZE)})`,
        });
        return;
      }

      if (abandoned()) return;

      // Generate our ECDH keypair and derive shared secret
      setState({ status: 'generating_answer', message: 'Generating keys...' });

      const ecdhKeyPair = await generateECDHKeyPair();
      const senderPublicKey = new Uint8Array(senderPublicKeyArray);
      const salt = new Uint8Array(saltArray);

      // Derive shared secret as non-extractable CryptoKey
      const sharedSecretKey = await deriveSharedSecretKey(
        ecdhKeyPair.privateKey,
        senderPublicKey,
      );
      const key = await deriveAESKeyFromSecretKey(sharedSecretKey, salt);
      // Signs the answer once its fields are settled: proves to the sender
      // that this answer, unaltered, came from a peer that read its offer and
      // reached the same shared secret. Travels inside the answer code with
      // nothing for either operator to read or type.
      const signAnswer = (answerTranscriptHash: string) =>
        deriveAnswerConfirmation(sharedSecretKey, salt, {
          offerTranscriptHash,
          answerTranscriptHash,
        });

      if (abandoned()) return;

      // Create WebRTC connection and handle offer
      setState({
        status: 'generating_answer',
        message: 'Creating P2P answer...',
      });

      const iceCandidates: RTCIceCandidate[] = [];
      let answerSDP: RTCSessionDescriptionInit | null = null;

      // Decrypted chunks land in the receive sink as they arrive. A cancel
      // during its creation cannot see it through sinkRef yet, so discard it
      // here instead of leaving its scratch storage orphaned.
      const sink = await createAdaptiveAppendSink(fileSize);
      if (abandoned()) {
        void sink.discard();
        return;
      }
      sinkRef.current = sink;

      // Streaming receiver: decrypts each chunk into the sink as it arrives
      // (inflating deflated payloads in between) and resolves once DONE
      // arrives and all chunks authenticate.
      const receiver = createTransferReceiver(key, contentEncoding, sink, {
        estimatedBytes: fileSize,
        onProgress: (current, total) =>
          setState((s) => ({ ...s, progress: { current, total } })),
      });
      let dataChannelResolver: (() => void) | null = null;
      let connectionFailedRejecter: ((error: Error) => void) | null = null;
      let answerSDPResolver: (() => void) | null = null;
      // A dead route can be known before the wait promise below exists (while
      // ICE is still gathering, or the answer code is being built). With no rejecter to hand it to yet, the failure is held
      // here so the wait fails fast instead of riding out the full timeout.
      let earlyConnectionFailure: Error | null = null;

      const rtc = new WebRTCConnection(
        getWebRTCConfig(),
        (signal) => {
          // Collect signals (answer + candidates)
          if (signal.type === 'answer') {
            answerSDP = { type: 'answer', sdp: signal.sdp };
            if (answerSDPResolver) {
              answerSDPResolver();
            }
          } else if (signal.type === 'candidate' && signal.candidate) {
            iceCandidates.push(new RTCIceCandidate(signal.candidate));
          }
        },
        () => {
          // Data channel opened; the idle watchdog covers the receiving stage
          // from here on.
          receiver.start();
          if (dataChannelResolver) {
            dataChannelResolver();
          }
        },
        (data) => {
          receiver.onMessage(data);
        },
        (connectionState) => {
          // A dead route is known long before the connection timeout; the
          // relay fallback (below) starts from it right away. If it fails
          // before the wait promise is set up, record it so that promise can
          // reject at once rather than waiting out the timeout.
          if (
            connectionState === 'failed' ||
            connectionState === 'disconnected'
          ) {
            const error = new P2PConnectionError('Connection failed');
            if (connectionFailedRejecter) connectionFailedRejecter(error);
            else earlyConnectionFailure ??= error;
          }
        },
      );

      if (abandoned()) {
        rtc.close();
        return;
      }
      rtcRef.current = rtc;

      // Handle offer signal
      await rtc.handleSignal({ type: 'offer', sdp: offerPayload.sdp });

      // Add ICE candidates from offer
      for (const candidateStr of offerPayload.candidates) {
        await rtc.handleSignal({
          type: 'candidate',
          candidate: { candidate: candidateStr, sdpMid: '0', sdpMLineIndex: 0 },
        });
      }

      if (abandoned()) return;

      // Wait for answer SDP to be generated
      setState({
        status: 'generating_answer',
        message: 'Generating answer...',
      });

      await new Promise<void>((resolve) => {
        if (answerSDP) {
          resolve();
        } else {
          answerSDPResolver = resolve;
          // Timeout after 10 seconds
          setTimeout(resolve, 10000);
        }
      });

      if (abandoned()) return;

      // Wait for ICE gathering to complete
      setState({
        status: 'generating_answer',
        message: 'Gathering network info...',
      });
      const iceGatheringComplete = await rtc.waitForIceGatheringComplete(
        ICE_GATHER_TIMEOUT_MS,
      );
      if (!iceGatheringComplete) {
        console.warn(
          'ICE gathering timed out while generating answer; continuing with available candidates',
        );
      }
      setState({
        status: 'generating_answer',
        message: iceGatheringComplete
          ? 'Preparing response code...'
          : 'Network probe timed out. Preparing response code with available routes...',
      });

      if (abandoned()) return;

      // Validate answerSDP is available
      if (!answerSDP) {
        throw new Error(
          'Failed to generate answer SDP: Answer was not created by WebRTC connection',
        );
      }

      // Generate answer with our public key
      const answerBinary = await generateMutualAnswerBinary(
        answerSDP,
        iceCandidates,
        ecdhKeyPair.publicKeyBytes,
        signAnswer,
      );

      const fileMetadata = {
        fileName: fileName!,
        fileSize: fileSize!,
        mimeType: mimeType!,
      };

      // The relays the offer named, if any: the control relays of the
      // file-relay fallback used only after the direct connection fails.
      // The answer itself is always hand-carried back to the sender.
      const offerRelays = relaysFromOffer(offerPayload);

      // Show answer and wait for connection
      setState({
        status: 'showing_answer',
        message: 'Show this to sender and wait for connection',
        answerData: answerBinary,
        contentType: 'file',
        fileMetadata,
      });

      // Wait for the data channel to open. When no direct route exists and
      // the offer named relays, the file comes through them instead;
      // without relays, or past the relay size cap, the failure stands.
      try {
        await new Promise<void>((resolve, reject) => {
          // A failure that landed before this promise existed is not lost.
          if (earlyConnectionFailure) {
            reject(earlyConnectionFailure);
            return;
          }
          const timeout = setTimeout(
            () => {
              reject(new P2PConnectionError('Connection timeout'));
            },
            offerRelays
              ? RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS
              : CODE_CONNECTION_TIMEOUT_MS,
          );

          dataChannelResolver = () => {
            clearTimeout(timeout);
            resolve();
          };
          connectionFailedRejecter = (error) => {
            clearTimeout(timeout);
            reject(error);
          };

          // Check if already open
          const dc = rtc.getDataChannel();
          if (dc && dc.readyState === 'open') {
            clearTimeout(timeout);
            resolve();
          }
        });
      } catch (error) {
        connectionFailedRejecter = null;
        if (
          !(error instanceof P2PConnectionError) ||
          !offerRelays ||
          abandoned()
        ) {
          throw error;
        }
        if (fileSize > SLOW_TRANSPORT_MAX_BYTES) {
          throw new P2PConnectionError(
            `${error.message}. The file is over ${formatFileSize(SLOW_TRANSPORT_MAX_BYTES)}, so it cannot be relayed through Nostr either.`,
          );
        }
        // The WebRTC side is done for; the relay transfer assembles the
        // file itself, so the streaming receiver and its sink go too.
        receiver.dispose();
        rtc.close();
        rtcRef.current = null;
        discardSink();

        const pool = createTransferPool();
        relayPoolRef.current = pool;
        let lastStats: TransferState['stats'];
        const relayState = {
          contentType: 'file' as const,
          fileMetadata,
          currentRelays: offerRelays,
        };
        setState({
          status: 'fetching',
          message: `${RELAY_FALLBACK_MESSAGE}. Connecting to relays...`,
          progress: { current: 0, total: fileSize },
          ...relayState,
        });
        let data: Uint8Array;
        try {
          const session = await deriveRelaySession(sharedSecretKey, salt);
          data = await receiveFileLive(session, offerRelays, {
            pool,
            isCancelled: abandoned,
            since: Math.floor(offerPayload.createdAt / 1000),
            expiresAt: Math.floor(
              (offerPayload.createdAt + TRANSFER_EXPIRATION_MS) / 1000,
            ),
            onProgress: (p) => {
              if (abandoned()) return;
              lastStats = p.stats;
              const total = p.manifest?.fileSize ?? fileSize;
              const chunkBytes = Math.ceil(total / Math.max(p.chunksTotal, 1));
              setState({
                status: 'fetching',
                message: !p.manifest
                  ? `${RELAY_FALLBACK_MESSAGE}. Waiting for the sender...`
                  : p.chunksDone === p.chunksTotal
                    ? 'All pieces received — verifying...'
                    : `Receiving pieces through relays... ${p.chunksDone}/${p.chunksTotal} (sender has uploaded ${p.available})`,
                progress: {
                  current: Math.min(p.chunksDone * chunkBytes, total),
                  total,
                },
                ...relayState,
                stats: p.stats,
              });
            },
          });
        } catch (relayError) {
          if (relayError instanceof NostrFileCancelledError) return;
          throw relayError;
        } finally {
          if (relayPoolRef.current === pool) relayPoolRef.current = null;
          pool.destroy();
        }
        if (abandoned()) return;
        setReceivedContent({
          contentType: 'file',
          data: new Blob([data as BlobPart], {
            type: mimeType || 'application/octet-stream',
          }),
          fileName,
          fileSize: data.length,
          mimeType,
        });
        setState({
          status: 'complete',
          message: 'File received through Nostr relays!',
          contentType: 'file',
          fileMetadata: { fileName, fileSize: data.length, mimeType },
          stats: lastStats,
        });
        return;
      }

      if (abandoned()) return;

      setState({
        status: 'receiving',
        message: 'Receiving file...',
        contentType: 'file',
        fileMetadata: {
          fileName: fileName!,
          fileSize: fileSize!,
          mimeType: mimeType!,
        },
        useWebRTC: true,
        progress: { current: 0, total: fileSize! },
      });

      // Wait for the streaming receiver to finish, racing cancellation. The
      // receiver decrypts, authenticates and writes chunks to the sink as they
      // arrive and resolves with the sealed payload. A stalled stream is
      // aborted by the receiver's own idle watchdog (see
      // createTransferReceiver).
      const receivedData = await new Promise<Blob>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (abandoned()) {
            clearInterval(checkInterval);
            receiver.dispose();
            reject(new Error('Cancelled'));
          }
        }, 500);

        receiver.done
          .then((data) => {
            clearInterval(checkInterval);
            resolve(data);
          })
          .catch((err) => {
            clearInterval(checkInterval);
            reject(err);
          });
      });

      if (abandoned()) return;

      // Acknowledge only after all chunks authenticate and reassemble.
      rtc.send(ACK);

      // Set received content
      setReceivedContent({
        contentType: 'file',
        data: receivedData,
        fileName: fileName!,
        fileSize: receivedData.size,
        mimeType: mimeType!,
      });
      setState({
        status: 'complete',
        message: 'File received (P2P)!',
        contentType: 'file',
        fileMetadata: {
          fileName: fileName!,
          fileSize: receivedData.size,
          mimeType: mimeType!,
        },
      });
    } catch (error) {
      // Nothing downloadable survives a failed transfer; drop its storage
      // — unless a newer run owns the sink by now.
      if (!abandoned()) {
        discardSink();
        setState((prevState) => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive',
          connectionFailed: error instanceof P2PConnectionError,
        }));
      }
    } finally {
      // A superseded run's refs already belong to the newer receive.
      if (runRef.current === run) {
        receivingRef.current = false;
        offerStepRef.current = null;
        if (rtcRef.current) {
          rtcRef.current.close();
          rtcRef.current = null;
        }
      }
    }
  };

  return {
    state,
    receivedContent,
    startReceive,
    submitOffer,
    cancel,
    reset,
  };
}
