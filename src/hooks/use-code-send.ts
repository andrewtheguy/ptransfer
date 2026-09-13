import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BROWSER_EXCHANGE_HOST } from '@/lib/code-exchange/browser-host';
import { hangUp } from '@/lib/code-exchange/hang-up';
import {
  completeSend,
  createSenderOffer,
  readAnswer,
  type SenderFallback,
  startSenderFallback,
} from '@/lib/code-exchange/send';
import {
  describeSendSource,
  torFallbackRefusal,
} from '@/lib/code-exchange/source';
import { createTorProgress } from '@/lib/code-exchange/tor-progress';
import type { SignalingPayload } from '@/lib/code-signaling';
import { TRANSFER_EXPIRATION_MS } from '@/lib/crypto';
import type { DuplexChannel } from '@/lib/duplex-channel';
import { P2PConnectionError } from '@/lib/errors';
import { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';
import type { NostrFileTransferStats } from '@/lib/nostr-file/stats';
import type { TorBridge } from '@/lib/tor/bridge';
import { bootstrapTorClient } from '@/lib/tor/client';
import type { TransferSource } from '@/lib/transfer-source';
import type { WebRTCConnection } from '@/lib/webrtc';

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

export function useCodeSend(): UseCodeSendReturn {
  const [state, setState] = useState<CodeTransferState>({ status: 'idle' });

  const rtcRef = useRef<WebRTCConnection | null>(null);
  // The data channel once it opens, so a cancel can tell the receiver.
  const channelRef = useRef<DuplexChannel | null>(null);
  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  const expirationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Resolve function for answer submission
  const answerResolverRef = useRef<
    ((payload: SignalingPayload) => void) | null
  >(null);
  const answerRejectRef = useRef<((error: Error) => void) | null>(null);

  // The fallback prepared behind the exchange: the relays the offer names
  // and, if the direct connection fails, what carries the file.
  const fallbackRef = useRef<SenderFallback | null>(null);
  // The Tor client behind an anonymous fallback. Null for a clearnet
  // transfer, which never loads one. Closing it takes the bootstrap, every
  // relay socket, and every circuit with it.
  const transportRef = useRef<AnonymousSignalingTransport | null>(null);

  const teardownFallback = useCallback(() => {
    fallbackRef.current?.close();
    fallbackRef.current = null;
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

  const closeConnection = useCallback(() => {
    rtcRef.current?.close();
    rtcRef.current = null;
    channelRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    sendingRef.current = false;
    clearExpirationTimeout();
    teardownFallback();
    answerResolverRef.current = null;
    answerRejectRef.current = null;
    // A receiver mid-transfer is told why the connection is going away.
    hangUp(rtcRef.current, channelRef.current);
    rtcRef.current = null;
    channelRef.current = null;
    setState({ status: 'idle' });
  }, [clearExpirationTimeout, teardownFallback]);

  // Navigating away ends the transfer, as it does in the Tor modes: nothing
  // reaches this hook once it is gone, and an anonymous fallback left running
  // would hold a Tor client, its circuits, and an onion service until the
  // session expired.
  useEffect(() => () => cancel(), [cancel]);

  // The scanned or pasted answer lands here; the sender's explicit action is
  // the only way an answer ever enters the flow.
  const submitAnswer = useCallback((answerBinary: Uint8Array) => {
    if (!answerResolverRef.current) return;
    try {
      answerResolverRef.current(readAnswer(answerBinary));
    } catch (error) {
      answerRejectRef.current?.(
        error instanceof Error ? error : new Error('Invalid response'),
      );
    }
    answerResolverRef.current = null;
  }, []);

  const send = useCallback(
    async (content: TransferSource, options: CodeSendOptions) => {
      // Guard against concurrent invocations
      if (sendingRef.current) return;
      sendingRef.current = true;
      cancelledRef.current = false;
      const isCancelled = () => cancelledRef.current;
      // Decides both halves of the fallback at once, and nothing else: the
      // exchange, the direct attempt and the code itself are the same either
      // way. Read once here so no branch below can disagree with the offer.
      const anonymous = options.anonymousRelay;

      try {
        const described = describeSendSource(
          content,
          BROWSER_EXCHANGE_HOST.maxTransferBytes,
        );
        if ('error' in described) {
          setState({ status: 'error', message: described.error });
          return;
        }
        const { metadata } = described;
        const { fileName, fileSize, mimeType } = metadata;

        // The fallback's own ceiling, checked here rather than where the
        // fallback starts: the protocol puts the refusal on the selection.
        const torRefusal = anonymous ? torFallbackRefusal(content) : null;
        if (torRefusal) {
          setState({ status: 'error', message: torRefusal });
          return;
        }

        teardownFallback();
        // The anonymous fallback needs a Tor client, and that is minutes
        // rather than seconds. Starting the bootstrap here — behind the
        // exchange, exactly where the clearnet path proves its relays — is
        // what keeps the fallback from beginning one only once the direct
        // route is known to be dead. Bootstrapping publishes nothing: the
        // onion service is established after the response is accepted, and
        // not before.
        const torProgress = createTorProgress();
        let transport: AnonymousSignalingTransport | null = null;
        if (anonymous) {
          const onStatus = (message: string) => {
            console.info('[tor] Code Exchange fallback:', message);
            torProgress.push(message);
          };
          transport = new AnonymousSignalingTransport({
            bootstrap: () =>
              bootstrapTorClient({ bridge: options.bridge, onStatus }),
          });
          transportRef.current = transport;
        }
        const fallback = startSenderFallback({
          kind: anonymous ? 'anonymous' : 'relay',
          host: BROWSER_EXCHANGE_HOST,
          transport,
          isCancelled,
        });
        fallbackRef.current = fallback;

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
            teardownFallback();
            closeConnection();
          }
        }, TRANSFER_EXPIRATION_MS);

        const report = (update: Parameters<typeof setState>[0]) => {
          if (!cancelledRef.current) setState(update);
        };

        const offer = await createSenderOffer({
          metadata,
          host: BROWSER_EXCHANGE_HOST,
          fallback,
          isCancelled,
          report,
          onConnection: (rtc) => {
            rtcRef.current = rtc;
          },
        });
        if (!offer || cancelledRef.current) return;
        void (async () => {
          const channel = await offer.channelOpened;
          if (rtcRef.current === offer.rtc) channelRef.current = channel;
        })();

        // Show offer and wait for answer
        setState({
          status: 'showing_offer',
          message: 'Show this to receiver, then scan/paste their response',
          offerData: offer.offerBinary,
          contentType: 'file',
          fileMetadata: { fileName, fileSize, mimeType },
        });

        const answer = await new Promise<SignalingPayload>(
          (resolve, reject) => {
            const checkInterval = setInterval(() => {
              if (cancelledRef.current) {
                clearInterval(checkInterval);
                reject(new Error('Cancelled'));
              }
            }, 500);
            answerResolverRef.current = (payload) => {
              clearInterval(checkInterval);
              resolve(payload);
            };
            answerRejectRef.current = (error) => {
              clearInterval(checkInterval);
              reject(error);
            };
          },
        );
        if (cancelledRef.current) return;

        // The answer is in hand. The fallback stays up so its background
        // sweep runs on behind the P2P transfer, as it does behind a relayed
        // one; the final teardown ends it.
        await completeSend({
          host: BROWSER_EXCHANGE_HOST,
          offer,
          answer,
          content,
          metadata,
          fallback,
          torProgress: transport ? torProgress : null,
          isCancelled,
          report,
          answerMismatchMessage:
            'Response does not match this transfer. Make sure you scanned the response to this code, then try again.',
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
        teardownFallback();
        sendingRef.current = false;
        answerResolverRef.current = null;
        answerRejectRef.current = null;
        closeConnection();
      }
    },
    [clearExpirationTimeout, teardownFallback, closeConnection],
  );

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, send, submitAnswer, cancel }),
    [state, send, submitAnswer, cancel],
  );
}
