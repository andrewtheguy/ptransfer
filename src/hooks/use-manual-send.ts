import { useCallback, useMemo, useRef, useState } from 'react';
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
import { sendFileOverDataChannel } from '@/lib/p2p-transfer';
import { type TransferSource, wireEncodingFor } from '@/lib/transfer-source';
import { WebRTCConnection } from '@/lib/webrtc';
import { getWebRTCConfig } from '@/lib/webrtc-config';

// Extended transfer status for Manual Exchange mode
export type ManualTransferStatus =
  | 'idle'
  | 'generating_offer'
  | 'showing_offer'
  | 'waiting_for_answer'
  | 'connecting'
  | 'transferring'
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
  // Set on an error state when a direct P2P connection could not be established;
  // drives the offline-QR fallback suggestion in the UI.
  connectionFailed?: boolean;
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
const MANUAL_CONNECTION_TIMEOUT_MS = 120000;

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
    answerResolverRef.current = null;
    answerRejectRef.current = null;
    ecdhPrivateKeyRef.current = null;
    saltRef.current = null;
    if (rtcRef.current) {
      rtcRef.current.close();
      rtcRef.current = null;
    }
    setState({ status: 'idle' });
  }, [clearExpirationTimeout]);

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
          },
        );

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
            answerResolverRef.current = resolve;
            answerRejectRef.current = reject;

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
        // Derive shared secret as non-extractable CryptoKey
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

        // Wait for data channel to open
        await new Promise<void>((resolve, reject) => {
          const pc = rtc.getPeerConnection();
          const dc = rtc.getDataChannel();
          const timeout = setTimeout(() => {
            cleanup();
            reject(new P2PConnectionError('Connection timeout'));
          }, MANUAL_CONNECTION_TIMEOUT_MS);

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
    [clearExpirationTimeout],
  );

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, send, submitAnswer, cancel }),
    [state, send, submitAnswer, cancel],
  );
}
