import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppendSink } from '@/lib/append-sink';
import { BROWSER_EXCHANGE_HOST } from '@/lib/code-exchange/browser-host';
import {
  buildDirectAttempt,
  deriveAnswerKeys,
  eligibleFallbackRelays,
  finishDirectReceive,
  receiveOverFallback,
  unrelayableError,
} from '@/lib/code-exchange/receive';
import { createTorProgress } from '@/lib/code-exchange/tor-progress';
import { wipeBufferSource } from '@/lib/crypto';
import { P2PConnectionError } from '@/lib/errors';
import {
  awaitCarriedOffer,
  type NostrClient,
  type TransferState,
} from '@/lib/nostr';
import { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';
import type { createTransferPool } from '@/lib/nostr-file/transfer-pool';
import {
  acceptPinOffer,
  claimPin,
  DIRECT_ATTEMPT_TIMEOUT_MS,
  NO_FALLBACK_ATTEMPT_TIMEOUT_MS,
  OFFER_WAIT_TIMEOUT_MS,
  pinReceiverConfirmation,
} from '@/lib/pin-exchange/receive';
import {
  openPinSignaling,
  pinSignalingRelays,
} from '@/lib/pin-exchange/signaling';
import type { TorBridge } from '@/lib/tor/bridge';
import { bootstrapTorClient } from '@/lib/tor/client';
import type { PinKeyMaterial, ReceivedContent } from '@/lib/types';
import type { WebRTCConnection } from '@/lib/webrtc';

/**
 * PIN Exchange from the receive tab, on the handshake in
 * `lib/pin-exchange/receive.ts` and the Code Exchange session it settles into.
 * The CLI's counterpart is `cli/pin/receive.ts`, on the same two.
 *
 * What is left here is the page's own half: the state the tab renders, the
 * storage a received file lands in until it is downloaded, and the browser's
 * way of starting a Tor client.
 */

/**
 * How this receiver reaches the relays, read off the PIN rather than asked
 * for: an anonymous-length PIN can only have been published on the onion
 * pool, so the only thing left to choose is which Snowflake bridge this tab
 * uses to get there.
 */
export interface PinReceiveOptions {
  anonymous: boolean;
  /** Which Snowflake bridge to reach Tor through. Ignored when not anonymous. */
  bridge: TorBridge;
}

export interface UsePinReceiveReturn {
  state: TransferState;
  receivedContent: ReceivedContent | null;
  /**
   * The confirmation code to read aloud to the sender, available from the
   * moment the rendezvous payload opens until the sender's confirm arrives.
   */
  confirmationCode: string | null;
  receive: (
    pinMaterial: PinKeyMaterial,
    options: PinReceiveOptions,
  ) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function usePinReceive(): UsePinReceiveReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [receivedContent, setReceivedContent] =
    useState<ReceivedContent | null>(null);
  const [confirmationCode, setConfirmationCode] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  const receivingRef = useRef(false);
  // Distinguishes invocations; see the note where a run claims one.
  const runIdRef = useRef(0);
  // Closes everything the current run holds open: its relay client, the Tor
  // client behind an anonymous transfer, the wait for the sender's offer, the
  // peer connection, and the fallback's pool. Set by the run, called by
  // cancel.
  const releaseRef = useRef<(() => void) | null>(null);
  // Storage backing the in-flight or completed transfer. Discarded whenever
  // the payload it backs is abandoned; kept after completion because
  // receivedContent.data reads from it until reset.
  const sinkRef = useRef<AppendSink | null>(null);

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
    releaseRef.current?.();
    releaseRef.current = null;
    setState({ status: 'idle' });
  }, [discardSink]);

  const reset = useCallback(() => {
    cancel();
    discardSink();
    setReceivedContent(null);
  }, [cancel, discardSink]);

  // Navigating away ends the transfer and drops a completed payload: nothing
  // reaches this hook once it is gone, so neither can be read again.
  useEffect(() => () => reset(), [reset]);

  const receive = useCallback(
    async (pinMaterial: PinKeyMaterial, options: PinReceiveOptions) => {
      // Guard against concurrent invocations
      if (receivingRef.current) return;
      receivingRef.current = true;
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
      let closeCarriage: (() => void) | null = null;
      const rtcHolder: { current: WebRTCConnection | null } = { current: null };
      const poolHolder: {
        current: ReturnType<typeof createTransferPool> | null;
      } = { current: null };
      // Closing the connection is what tells a sender mid-transfer; any
      // other exit has already said what happened.
      const release = () => {
        rtcHolder.current?.close();
        rtcHolder.current = null;
        poolHolder.current?.destroy();
        poolHolder.current = null;
        closeCarriage?.();
        closeCarriage = null;
        client?.close();
        client = null;
        transport?.close();
        transport = null;
      };
      const cancelRelease = () => release();
      releaseRef.current = cancelRelease;

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

        // One Tor client for the whole anonymous transfer: its relay sockets
        // carry the handshake, and the Tor fallback reaches the sender's
        // onion service through it if no direct route opens.
        const torProgress = createTorProgress();
        let bootstrapOnScreen = true;
        if (options.anonymous) {
          const onStatus = (message: string) => {
            torProgress.push(message);
            if (bootstrapOnScreen && !abandoned()) {
              setState({ status: 'connecting', message });
            }
          };
          transport = new AnonymousSignalingTransport({
            bootstrap: () =>
              bootstrapTorClient({ bridge: options.bridge, onStatus }),
          });
        }

        // The pools are disjoint, so which one is right was settled by the
        // PIN's length; see ANONYMOUS_SIGNALING_RELAYS.
        const relays = pinSignalingRelays(options.anonymous);
        client = await openPinSignaling({
          anonymous: options.anonymous,
          transport,
          isCancelled: abandoned,
          report: (message) => {
            if (!abandoned()) setState({ status: 'connecting', message });
          },
          onTorUp: () => {
            bootstrapOnScreen = false;
          },
        });
        if (!client || abandoned()) return;
        const nostr = client;

        const session = await claimPin({
          client: nostr,
          pakeSecret: pinMaterial.pakeSecret,
          locator: pinMaterial.locator,
          isCancelled: abandoned,
          report: (update) => {
            if (!abandoned()) setState(update);
          },
        });
        if (!session || abandoned()) return;

        const { metadata } = session;
        const resolvedFileName = metadata.fileName || 'unknown';
        const resolvedFileSize = metadata.fileSize;
        const resolvedMimeType =
          metadata.mimeType || 'application/octet-stream';

        // The sender publishes nothing further — no connection offer, no file
        // byte — until its operator types this code.
        const { confirmationCode: code, signalsKey } =
          await pinReceiverConfirmation(session);
        if (abandoned()) return;
        setConfirmationCode(code);

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
          currentRelays: nostr.getRelays(),
          totalRelays: relays.length,
        });

        // The sender publishes nothing past its confirm until its operator
        // types that code, so the offer arriving is how this side learns the
        // code matched.
        const carriage = awaitCarriedOffer({
          client: nostr,
          secretKey: session.secretKey,
          transferId: session.transferId,
          senderPubkey: session.senderPubkey,
          signalsKey,
          isCancelled: abandoned,
          timeoutMs: OFFER_WAIT_TIMEOUT_MS,
          timeoutMessage:
            'The sender did not enter the confirmation code in time. Start a new transfer.',
        });
        closeCarriage = carriage.close;
        const offerCode = await carriage.offer;
        if (abandoned()) return;

        // The code has done its job.
        setConfirmationCode(null);
        const fileMetadata = {
          fileName: resolvedFileName,
          fileSize: resolvedFileSize,
          mimeType: resolvedMimeType,
        };
        setState({
          status: 'receiving',
          message: 'Sender confirmed — connecting...',
          contentType: 'file',
          fileMetadata,
          currentRelays: nostr.getRelays(),
          totalRelays: relays.length,
        });

        const offer = await acceptPinOffer(offerCode, {
          metadata,
          anonymous: options.anonymous,
        });

        const keys = await deriveAnswerKeys(offer);
        if (abandoned()) return;
        const fallbackRelays = eligibleFallbackRelays(offer);
        const attempt = await buildDirectAttempt({
          offer,
          keys,
          host: BROWSER_EXCHANGE_HOST,
          sinkHolder: sinkRef,
          rtcHolder,
          connectionTimeoutMs: fallbackRelays
            ? DIRECT_ATTEMPT_TIMEOUT_MS
            : NO_FALLBACK_ATTEMPT_TIMEOUT_MS,
          isCancelled: abandoned,
          // The answer is built behind the "connecting" line above; its
          // steps are the response page's in Code Exchange, not this one's.
          report: (update) => {
            if (update.status !== 'generating_answer' && !abandoned()) {
              setState(update);
            }
          },
          onProgress: (current, total) =>
            setState((s) => ({
              ...s,
              status: 'receiving',
              progress: { current, total },
            })),
        });
        if (!attempt) return;
        await carriage.answer(attempt.answerBinary);
        if (abandoned()) return;

        try {
          await attempt.opened;
        } catch (error) {
          attempt.dispose();
          if (
            !(error instanceof P2PConnectionError) ||
            !offer.fallbackRelays ||
            abandoned()
          ) {
            throw error;
          }
          if (!fallbackRelays) throw unrelayableError(offer, error);
          // The offer and answer have done their job; the fallback meets the
          // sender on its own control channel from here.
          carriage.close();
          const receipt = await receiveOverFallback({
            offer,
            keys,
            host: BROWSER_EXCHANGE_HOST,
            transport,
            torProgress,
            hold: null,
            poolHolder,
            switchedBack: () => false,
            isCancelled: abandoned,
            report: (update) => {
              if (!abandoned()) setState(update);
            },
          });
          if (!receipt || receipt === 'switched') return;
          if (abandoned()) {
            void receipt.sink?.discard();
            return;
          }
          // Held like a direct receive's sink: a reset, the next receive, or
          // unmounting discards it. The direct attempt was disposed above, so
          // there is no other sink in the ref to lose.
          sinkRef.current = receipt.sink ?? null;
          setReceivedContent(receipt.content);
          setState({
            status: 'complete',
            message: receipt.message,
            contentType: 'file',
            fileMetadata: {
              fileName: receipt.content.fileName,
              fileSize: receipt.content.fileSize,
              mimeType: receipt.content.mimeType,
            },
            stats: receipt.stats,
          });
          return;
        }
        carriage.close();

        setState({
          status: 'receiving',
          message: 'Receiving via P2P...',
          contentType: 'file',
          fileMetadata,
          useWebRTC: true,
          progress: { current: 0, total: resolvedFileSize },
        });
        const payload = await finishDirectReceive({
          attempt,
          rtcHolder,
          isCancelled: abandoned,
        });
        if (!payload || abandoned()) return;

        setReceivedContent({
          contentType: 'file',
          data: payload,
          fileName: resolvedFileName,
          fileSize: payload.size,
          mimeType: resolvedMimeType,
        });
        setState({
          status: 'complete',
          message: 'File received (P2P)!',
          contentType: 'file',
          fileMetadata: {
            fileName: resolvedFileName,
            fileSize: payload.size,
            mimeType: resolvedMimeType,
          },
          useWebRTC: true,
        });
      } catch (error) {
        // A superseded run reports nothing and abandons nothing: the sink and
        // the code on screen are the replacement's now, and its own storage
        // was discarded when it was cancelled.
        if (!superseded()) {
          // Nothing downloadable survives a failed transfer; drop its storage.
          discardSink();
          setConfirmationCode(null);
          if (!abandoned()) {
            setState((prevState) => ({
              ...prevState,
              status: 'error',
              message:
                error instanceof Error ? error.message : 'Failed to receive',
              connectionFailed: error instanceof P2PConnectionError,
            }));
          }
        }
      } finally {
        // The guard belongs to whichever run is current, so only that run may
        // release it — clearing it here would let a third transfer start while
        // the second is still running.
        if (!superseded()) receivingRef.current = false;
        // Idempotent backstop for early exits — the handshake already wiped it
        // the moment its claims settled.
        wipeBufferSource(pinMaterial.pakeSecret);
        if (releaseRef.current === cancelRelease) releaseRef.current = null;
        release();
      }
    },
    [discardSink],
  );

  return { state, receivedContent, confirmationCode, receive, cancel, reset };
}
