import { useCallback, useRef, useState } from 'react';
import { deriveAnswerChannel, publishAnswer } from '@/lib/answer-channel';
import {
  deriveAESKeyFromSecretKey,
  deriveSharedSecretKey,
  generateECDHKeyPair,
  MAX_MESSAGE_SIZE,
  TRANSFER_EXPIRATION_MS,
} from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import { formatFileSize } from '@/lib/file-utils';
import {
  answerChannelFromOffer,
  generateMutualAnswerBinary,
  parseMutualPayload,
  type SignalingPayload,
} from '@/lib/manual-signaling';
import type { TransferState } from '@/lib/nostr';
import { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import { ACK, createDataChannelReceiver } from '@/lib/p2p-transfer';
import { type AppendSink, createAdaptiveAppendSink } from '@/lib/scratch-sink';
import type { ReceivedContent } from '@/lib/types';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';

// Extended transfer status for Manual Exchange receive mode
export type ManualReceiveStatus =
  | 'idle'
  | 'waiting_for_offer'
  | 'generating_answer'
  | 'showing_answer'
  | 'connecting'
  | 'receiving'
  | 'complete'
  | 'error';

// Typed manual receive state for UI consumers.
export interface ManualReceiveState {
  status: ManualReceiveStatus;
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
  clipboardData?: string; // Base64 for copy button
  /**
   * Outcome of returning the answer over the relays the offer named:
   * 'sent' when at least one relay took it (the sender gets it without a
   * second hand-carried hop), 'failed' when none did. Absent when the offer
   * named no relays, which is the plain two-hop exchange.
   */
  answerRelayStatus?: 'sent' | 'failed';
}

export interface UseManualReceiveReturn {
  state: TransferState & ManualReceiveState;
  receivedContent: ReceivedContent | null;
  startReceive: () => void;
  submitOffer: (offerData: Uint8Array) => void;
  cancel: () => void;
  reset: () => void;
}

const ICE_GATHER_TIMEOUT_MS = 5000;
const MANUAL_CONNECTION_TIMEOUT_MS = 120000;

export function useManualReceive(): UseManualReceiveReturn {
  const [state, setState] = useState<TransferState & ManualReceiveState>({
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
  // Pool carrying the answer to the relays, held only for the publish. Cancel
  // reaches it through this ref so an abandoned receive stops publishing
  // instead of finishing the round on a dead session.
  const answerPoolRef = useRef<ReturnType<typeof createTransferPool> | null>(
    null,
  );

  // Resolve function for offer submission
  const offerResolverRef = useRef<((payload: SignalingPayload) => void) | null>(
    null,
  );
  const offerRejectRef = useRef<((error: Error) => void) | null>(null);

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
    const answerPool = answerPoolRef.current;
    answerPoolRef.current = null;
    if (answerPool) answerPool.destroy();
    receivingRef.current = false;
    offerResolverRef.current = null;
    offerRejectRef.current = null;
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
    if (!offerResolverRef.current) return;

    // Parse mutual payload (no decryption needed)
    const parsed = await parseMutualPayload(offerData);
    if (!parsed) {
      offerRejectRef.current?.(new Error('Invalid offer format'));
      offerRejectRef.current = null;
      offerResolverRef.current = null;
      return;
    }
    if (parsed.type !== 'offer') {
      offerRejectRef.current?.(new Error('Expected offer, got answer'));
      offerRejectRef.current = null;
      offerResolverRef.current = null;
      return;
    }
    offerResolverRef.current?.(parsed);
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
    try {
      // Show input for scanning/pasting offer
      setState({
        status: 'waiting_for_offer',
        message: "Scan or paste the sender's code",
      });

      // Wait for offer to be submitted
      const offerPayload = await new Promise<SignalingPayload>(
        (resolve, reject) => {
          offerResolverRef.current = resolve;
          offerRejectRef.current = reject;

          // Check periodically if cancelled
          const checkInterval = setInterval(() => {
            if (cancelledRef.current) {
              clearInterval(checkInterval);
              reject(new Error('Cancelled'));
            }
          }, 500);
        },
      );

      if (cancelledRef.current) return;

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

      if (cancelledRef.current) return;

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

      if (cancelledRef.current) return;

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
      if (cancelledRef.current) {
        void sink.discard();
        return;
      }
      sinkRef.current = sink;

      // Streaming receiver: decrypts each chunk into the sink as it arrives
      // (inflating deflated payloads in between) and resolves once DONE
      // arrives and all chunks authenticate.
      const receiver = createDataChannelReceiver(key, contentEncoding, sink, {
        estimatedBytes: fileSize,
        onProgress: (current, total) =>
          setState((s) => ({ ...s, progress: { current, total } })),
      });
      let dataChannelResolver: (() => void) | null = null;
      let answerSDPResolver: (() => void) | null = null;

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
      );

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

      if (cancelledRef.current) return;

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

      if (cancelledRef.current) return;

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

      if (cancelledRef.current) return;

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
      );

      // When the offer named an answer channel, seal the same blob under the
      // offer's secret and publish it there: the sender is already listening,
      // so nothing has to be carried back by hand. A refusal is not fatal —
      // the answer code is shown and the exchange finishes as it always did.
      const answerChannel = answerChannelFromOffer(offerPayload);
      let answerRelayStatus: 'sent' | 'failed' | undefined;
      if (answerChannel) {
        setState({
          status: 'generating_answer',
          message: 'Sending your response to the sender...',
        });
        const pool = createTransferPool();
        answerPoolRef.current = pool;
        try {
          await publishAnswer(pool, answerChannel.relays, {
            channel: await deriveAnswerChannel(answerChannel.secret),
            answer: answerBinary,
            expiresAt: Math.floor(
              (offerPayload.createdAt + TRANSFER_EXPIRATION_MS) / 1000,
            ),
          });
          answerRelayStatus = 'sent';
        } catch {
          answerRelayStatus = 'failed';
        } finally {
          answerPoolRef.current = null;
          pool.destroy();
        }
      }

      if (cancelledRef.current) return;

      // Show answer and wait for connection
      setState({
        status: 'showing_answer',
        message:
          answerRelayStatus === 'sent'
            ? 'Response sent — waiting for the sender to connect'
            : 'Show this to sender and wait for connection',
        answerData: answerBinary,
        answerRelayStatus,
        contentType: 'file',
        fileMetadata: {
          fileName: fileName!,
          fileSize: fileSize!,
          mimeType: mimeType!,
        },
      });

      // Wait for data channel to open
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new P2PConnectionError('Connection timeout'));
        }, MANUAL_CONNECTION_TIMEOUT_MS);

        dataChannelResolver = () => {
          clearTimeout(timeout);
          resolve();
        };

        // Check if already open
        const dc = rtc.getDataChannel();
        if (dc && dc.readyState === 'open') {
          clearTimeout(timeout);
          resolve();
        }
      });

      if (cancelledRef.current) return;

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
      // createDataChannelReceiver).
      const receivedData = await new Promise<Blob>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (cancelledRef.current) {
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

      if (cancelledRef.current) return;

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
      // Nothing downloadable survives a failed transfer; drop its storage.
      discardSink();
      if (!cancelledRef.current) {
        setState((prevState) => ({
          ...prevState,
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to receive',
          connectionFailed: error instanceof P2PConnectionError,
        }));
      }
    } finally {
      receivingRef.current = false;
      offerResolverRef.current = null;
      offerRejectRef.current = null;
      if (rtcRef.current) {
        rtcRef.current.close();
        rtcRef.current = null;
      }
    }
  };

  return { state, receivedContent, startReceive, submitOffer, cancel, reset };
}
