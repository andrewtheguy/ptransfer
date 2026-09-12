import { useCallback, useMemo, useRef, useState } from 'react';
import { BROWSER_EXCHANGE_HOST } from '@/lib/code-exchange/browser-host';
import { hangUp } from '@/lib/code-exchange/hang-up';
import {
  completeSend,
  createSenderOffer,
  readAnswer,
  type SenderFallback,
  type SendFallbackKind,
  startSenderFallback,
} from '@/lib/code-exchange/send';
import {
  describeSendSource,
  torFallbackRefusal,
} from '@/lib/code-exchange/source';
import { createTorProgress } from '@/lib/code-exchange/tor-progress';
import type { PinKind } from '@/lib/crypto';
import type { DuplexChannel } from '@/lib/duplex-channel';
import { P2PConnectionError } from '@/lib/errors';
import type { TransferState } from '@/lib/nostr';
import {
  type ContentType,
  carryOfferForAnswer,
  type NostrClient,
} from '@/lib/nostr';
import { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';
import {
  ANSWER_WAIT_TIMEOUT_MS,
  CONFIRM_CODE_ENTRY_TIMEOUT_MS,
  confirmationCodeMatches,
  confirmPinClaim,
  OFFER_RETRY_MS,
  type PinRendezvous,
  startPinRendezvous,
} from '@/lib/pin-exchange/send';
import {
  openPinSignaling,
  pinSignalingRelays,
} from '@/lib/pin-exchange/signaling';
import type { TorBridge } from '@/lib/tor/bridge';
import { bootstrapTorClient } from '@/lib/tor/client';
import type { TransferSource } from '@/lib/transfer-source';
import type { WebRTCConnection } from '@/lib/webrtc';

/**
 * PIN Exchange from the send tab, on the handshake in
 * `lib/pin-exchange/send.ts` and the Code Exchange session it sets up. The
 * CLI's counterpart is `cli/pin/send.ts`, on the same two.
 *
 * What is left here is the page's own half: the state the tab renders, the
 * refs that let it refresh a PIN and submit the confirmation code, and the
 * browser's way of starting a Tor client.
 */

/**
 * What the sender chose on the send tab, beyond the files themselves.
 *
 * `anonymous` decides the whole mode at once: the PIN is minted at the
 * anonymous length, signaling is carried to the onion relay pool through Tor,
 * and the offer asks for the Tor fallback rather than the clearnet one. None
 * of these can disagree — the receiver reads the mode off the PIN's length,
 * so a PIN of one kind published on the other pool would simply never be
 * found, and a clearnet fallback would hand both devices' addresses to the
 * very relays the mode keeps them from.
 */
export interface PinSendOptions {
  /** Route this transfer's signaling, and its fallback, through Tor. */
  anonymous: boolean;
  /** Which Snowflake bridge to reach Tor through. Ignored when not anonymous. */
  bridge: TorBridge;
}

export interface UsePinSendReturn {
  state: TransferState;
  pin: string | null;
  send: (content: TransferSource, options: PinSendOptions) => Promise<void>;
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

export function usePinSend(): UsePinSendReturn {
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [pin, setPin] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  const sendingRef = useRef(false);
  // Distinguishes invocations; see the note where a run claims one.
  const runIdRef = useRef(0);
  // Closes everything the current run holds open: its relay client, the Tor
  // client behind an anonymous transfer, the fallback's relay pool and
  // sweep, and the peer connection. Set by the run, called by cancel.
  const releaseRef = useRef<(() => void) | null>(null);
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
    if (!confirmationCodeMatches(code, expected)) return false;
    confirmationCodeAcceptRef.current?.();
    return true;
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    sendingRef.current = false;
    refreshPinRef.current = null;
    expectedConfirmationCodeRef.current = null;
    confirmationCodeAcceptRef.current = null;
    releaseRef.current?.();
    releaseRef.current = null;
    setPin(null);
    setState({ status: 'idle' });
  }, []);

  const send = useCallback(
    async (content: TransferSource, options: PinSendOptions) => {
      // Guard against concurrent invocations
      if (sendingRef.current) return;
      sendingRef.current = true;
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
      let fallback: SenderFallback | null = null;
      let rendezvous: PinRendezvous | null = null;
      let rtc: WebRTCConnection | null = null;
      let channel: DuplexChannel | null = null;
      // A cancel tells a receiver mid-transfer why the connection is going
      // away; any other exit has already said what happened.
      const release = (cancelling = false) => {
        if (cancelling) hangUp(rtc, channel);
        else rtc?.close();
        rtc = null;
        channel = null;
        fallback?.close();
        fallback = null;
        rendezvous?.close();
        rendezvous = null;
        client?.close();
        client = null;
        transport?.close();
        transport = null;
      };
      const cancelRelease = () => release(true);
      releaseRef.current = cancelRelease;

      const contentType: ContentType = 'file';
      // The PIN's length is what tells the receiver which pool to look on, so
      // the kind and the relay set are decided together and never separately.
      const pinKind: PinKind = options.anonymous ? 'anonymous' : 'standard';
      const relays = pinSignalingRelays(options.anonymous);

      try {
        const described = describeSendSource(content);
        if ('error' in described) {
          setState({ status: 'error', message: described.error });
          return;
        }
        const { metadata } = described;
        const { fileName, fileSize, mimeType } = metadata;
        const fileMetadata = { fileName, fileSize, mimeType };

        if (abandoned()) return;

        // One Tor client for the whole anonymous transfer: its relay sockets
        // carry the handshake, and if no direct route opens, the Tor fallback
        // publishes its onion service on it too. Two would mean two
        // bootstraps, minutes each.
        const torProgress = createTorProgress();
        // While the handshake's relay sockets wait on the bootstrap, its
        // progress is the page's.
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

        // The fallback, prepared from the start rather than once a receiver
        // has turned up. Proving the relays the offer will name, preparing the
        // storage ring and sweeping the relay population behind it take as
        // long as they take, and the PIN on screen is a wait of its own they
        // run behind — so by the time a receiver has claimed and confirmed,
        // the offer's relays are proven and the ring is ready. An anonymous
        // transfer's fallback is the Tor one, unless the selection is more
        // than it can carry; then it has none, and a dead direct route ends
        // the transfer.
        const fallbackKind: SendFallbackKind = options.anonymous
          ? torFallbackRefusal(content)
            ? 'none'
            : 'anonymous'
          : 'relay';
        fallback = startSenderFallback({
          kind: fallbackKind,
          host: BROWSER_EXCHANGE_HOST,
          transport,
          isCancelled: abandoned,
        });
        const preparedFallback = fallback;

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

        setState({
          status: 'waiting_for_receiver',
          message: 'Waiting for receiver...',
          contentType,
          fileMetadata,
          useWebRTC: true,
          currentRelays: nostr.getRelays(),
          totalRelays: relays.length,
        });

        rendezvous = startPinRendezvous({
          client: nostr,
          pinKind,
          relays,
          isCancelled: abandoned,
          onPin: setPin,
        });
        const session = rendezvous;
        refreshPinRef.current = () => session.refresh();

        let claim: Awaited<typeof session.claimed>;
        try {
          claim = await session.claimed;
        } finally {
          // The ref belongs to whichever run is current, as in the outer
          // finally: a superseded run clearing it would take away the button
          // the replacement's PIN is being refreshed by.
          if (!superseded()) refreshPinRef.current = null;
        }

        if (abandoned()) return;

        // First-claim lockout: rotation has stopped and every retained PIN is
        // dead, so there is nothing left to display.
        setPin(null);

        // Mutual proof plus metadata delivery: the confirm is sealed under the
        // session's confirm key, which only the matching PAKE peer holds, so
        // publishing it is this side's PIN proof in the reverse direction.
        const { expectedCode, signalsKey } = await confirmPinClaim({
          client: nostr,
          rendezvous: session,
          claim,
          metadata,
        });

        if (abandoned()) return;

        // The offer is built while the operator types the code. It is
        // published only past the gate below, but gathering its candidates and
        // waiting on the fallback's relays need no human, so they need not
        // wait for one either.
        let offerOnScreen = false;
        const offerBuild = createSenderOffer({
          metadata,
          host: BROWSER_EXCHANGE_HOST,
          fallback: preparedFallback,
          isCancelled: abandoned,
          report: (update) => {
            if (offerOnScreen && !abandoned()) setState(update);
          },
          onConnection: (connection) => {
            rtc = connection;
          },
        });
        // Awaited only past the gate; a failure before then must not surface
        // as an unhandled rejection in the meantime.
        offerBuild.catch(() => undefined);

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
              if (abandoned() && !settled) {
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

        if (abandoned()) return;

        // The typed code matched: the human vouched for the peer we locked
        // onto, so the gate opens. From here this is a Code Exchange session
        // whose codes ride the sealed channel instead of a person's hand.
        offerOnScreen = true;
        setState({
          status: 'connecting',
          message: 'Preparing the connection...',
          contentType,
          fileMetadata,
        });
        const offer = await offerBuild;
        if (!offer || abandoned()) return;
        void (async () => {
          const opened = await offer.channelOpened;
          if (rtc === offer.rtc) channel = opened;
        })();

        setState({
          status: 'connecting',
          message: 'Sending the connection offer...',
          contentType,
          fileMetadata,
        });
        const answerCode = await carryOfferForAnswer({
          client: nostr,
          secretKey: session.secretKey,
          transferId: session.transferId,
          senderPubkey: session.publicKey,
          receiverPubkey: claim.receiverPubkey,
          signalsKey,
          isCancelled: abandoned,
          offer: offer.offerBinary,
          retryMs: OFFER_RETRY_MS,
          timeoutMs: ANSWER_WAIT_TIMEOUT_MS,
        });
        if (abandoned()) return;

        // Only the locked receiver can have sealed this, and the confirmation
        // tag inside it still has to bind it to this offer before anything in
        // it is acted on.
        await completeSend({
          offer,
          answer: readAnswer(answerCode),
          content,
          metadata,
          fallback: preparedFallback,
          torProgress: transport ? torProgress : null,
          isCancelled: abandoned,
          report: (update) => {
            if (!abandoned()) setState(update);
          },
          answerMismatchMessage:
            "The receiver's response does not match this transfer. Start a new transfer.",
        });
      } catch (error) {
        if (!abandoned()) {
          setPin(null);
          setState((prevState) => ({
            ...prevState,
            status: 'error',
            message: error instanceof Error ? error.message : 'Failed to send',
            connectionFailed: error instanceof P2PConnectionError,
          }));
        }
      } finally {
        // These belong to whichever run is current, so only that run may clear
        // them: a superseded run doing it would release the replacement's
        // concurrency guard and drop the code its operator is about to type.
        if (!superseded()) {
          sendingRef.current = false;
          refreshPinRef.current = null;
          expectedConfirmationCodeRef.current = null;
          confirmationCodeAcceptRef.current = null;
        }
        if (releaseRef.current === cancelRelease) releaseRef.current = null;
        // Closing the rendezvous is what wipes every PAKE secret it retained.
        release();
      }
    },
    [],
  );

  // Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(
    () => ({ state, pin, send, cancel, refreshPin, submitConfirmationCode }),
    [state, pin, send, cancel, refreshPin, submitConfirmationCode],
  );
}
