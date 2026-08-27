import { Download, FileDown, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCodeReceive } from '@/hooks/use-code-receive';
import { usePinReceive } from '@/hooks/use-pin-receive';
import { useTorReceive } from '@/hooks/use-tor-receive';
import {
  derivePakeSecret,
  getPinLocator,
  wipeBufferSource,
} from '@/lib/crypto';
import {
  downloadFile,
  formatFileSize,
  getMimeTypeDescription,
} from '@/lib/file-utils';
import { extractPinFromUrl } from '@/lib/pin-link';
import type { ReceiveInput as ReceiveInputValue } from '@/lib/receive-input';
import { DEFAULT_TOR_BRIDGE, type TorBridge } from '@/lib/tor/client';
import type { PinKeyMaterial } from '@/lib/types';
import { AnonymousReceiveForm } from './anonymous-receive-form';
import { AnswerReturn } from './answer-return';
import { ConfirmationCodeDisplay } from './confirmation-code-display';
import { ReceiveInput } from './receive-input';
import { TorReceiveForm } from './tor-receive-form';
import { TransferStatus } from './transfer-status';

/**
 * Which exchange the receiver's input turned out to belong to. Chosen from what
 * they pasted or scanned rather than asked for up front.
 */
type ReceiveRoute = 'none' | 'pin' | 'code' | 'tor';

export function ReceiveTab() {
  // Both hooks must be called unconditionally (React rules); the route picks
  // which one's state the UI reads.
  const {
    state: pinState,
    receivedContent: pinContent,
    confirmationCode,
    receive,
    cancel: cancelPin,
    reset: resetPin,
  } = usePinReceive();
  const {
    state: codeState,
    receivedContent: codeContent,
    startReceive,
    submitOffer,
    cancel: cancelCode,
    reset: resetCode,
  } = useCodeReceive();
  const {
    state: torState,
    receivedContent: torContent,
    receive: receiveOverTor,
    cancel: cancelTor,
    reset: resetTor,
  } = useTorReceive();

  const [route, setRoute] = useState<ReceiveRoute>('none');
  // Failures before either hook owns the transfer, which therefore have no
  // state of their own to report through.
  const [startError, setStartError] = useState<string | null>(null);
  // Held between startReceive() and the hook arming its offer step.
  const pendingOfferRef = useRef<Uint8Array | null>(null);
  // An anonymous PIN's key material, held while the bridge question is
  // answered. The PIN string itself is already gone by then — it is turned
  // into these two values the moment the box hands it over, so nothing is
  // parked here that the transfer would not have held anyway.
  const pendingPinRef = useRef<PinKeyMaterial | null>(null);
  // Whether that question is on screen. Separate from the ref because the ref
  // must not drive rendering and the material must not reach the render tree.
  const [awaitingAnonymousBridge, setAwaitingAnonymousBridge] = useState(false);
  // The onion address recognized in the box, while its password is asked for.
  const [torAddress, setTorAddress] = useState<string | null>(null);

  // A PIN QR deep-links here with the PIN in the fragment. Read it during the
  // first render so the input box can open prefilled.
  const [initialPin, setInitialPin] = useState(
    () => extractPinFromUrl(window.location.href) ?? undefined,
  );

  // Strip the PIN back out of the URL so it does not linger in the address bar
  // or browser history.
  useEffect(() => {
    if (!initialPin) return;
    window.history.replaceState(null, '', window.location.pathname);
  }, [initialPin]);

  const isCodeExchange = route === 'code';
  const isTor = route === 'tor';
  const state = isTor ? torState : isCodeExchange ? codeState : pinState;
  const receivedContent = isTor
    ? torContent
    : isCodeExchange
      ? codeContent
      : pinContent;

  // A PIN parked for the bridge question and then abandoned still holds a PAKE
  // scalar; the hook would have wiped it, so this stands in for the hook.
  const discardPendingPin = useCallback(() => {
    const material = pendingPinRef.current;
    pendingPinRef.current = null;
    setAwaitingAnonymousBridge(false);
    if (material) wipeBufferSource(material.pakeSecret);
  }, []);

  const startPinReceive = useCallback(
    async (material: PinKeyMaterial, bridge: TorBridge, anonymous: boolean) => {
      try {
        await receive(material, { anonymous, bridge });
      } catch (err) {
        // receive() reports its own failures through state; reaching here
        // means the transfer never started, so hand the box back.
        console.error('Failed to start PIN receive flow:', err);
        setRoute('none');
        setStartError('Could not start the transfer. Please try again.');
      }
    },
    [receive],
  );

  const handleSubmit = useCallback(
    async (input: ReceiveInputValue) => {
      // Spent: a later "Receive Another" must not refill the deep-link PIN.
      setInitialPin(undefined);
      setStartError(null);

      if (input.kind === 'pin') {
        setRoute('pin');
        let material: PinKeyMaterial;
        try {
          // The hook wipes the scalar once its PAKE runs are done.
          material = {
            pakeSecret: await derivePakeSecret(input.pin),
            locator: getPinLocator(input.pin),
          };
        } catch (err) {
          // Nothing has started yet, so hand the box back rather than route
          // into a hook that has no failure of its own to report.
          console.error('Failed to derive the PIN key material:', err);
          setRoute('none');
          setStartError('Could not start the transfer. Please try again.');
          return;
        }
        if (input.pinKind === 'anonymous') {
          // Nothing starts yet: bootstrapping Tor costs minutes, so which
          // bridge to spend them on is asked first.
          pendingPinRef.current = material;
          setAwaitingAnonymousBridge(true);
          return;
        }
        await startPinReceive(material, DEFAULT_TOR_BRIDGE, false);
        return;
      }

      if (input.kind === 'onion') {
        // Nothing starts yet: the password is a second secret, and it is
        // checked before a bootstrap that costs minutes.
        setTorAddress(input.address);
        setRoute('tor');
        return;
      }

      if (input.kind === 'offer') {
        pendingOfferRef.current = input.payload;
        setRoute('code');
        startReceive();
      }
      // 'offer-chunk' never reaches here: the scanner reassembles chunks, and
      // the paste box redirects a single chunk link to the Scan tab.
    },
    [startPinReceive, startReceive],
  );

  // submitOffer is a no-op until doReceive has armed its offer step, so hand
  // the offer over once the hook reports it is waiting.
  useEffect(() => {
    if (route !== 'code') return;
    if (codeState.status !== 'waiting_for_offer') return;
    const payload = pendingOfferRef.current;
    if (!payload) return;
    pendingOfferRef.current = null;
    void submitOffer(payload);
  }, [route, codeState.status, submitOffer]);

  const handleAnonymousBridge = useCallback(
    (bridge: TorBridge) => {
      const material = pendingPinRef.current;
      if (!material) return;
      pendingPinRef.current = null;
      setAwaitingAnonymousBridge(false);
      void startPinReceive(material, bridge, true);
    },
    [startPinReceive],
  );

  const handleTorPassword = useCallback(
    (password: string, bridge: TorBridge) => {
      if (!torAddress) return;
      void receiveOverTor({ address: torAddress, password, bridge });
    },
    [receiveOverTor, torAddress],
  );

  const handleCancel = useCallback(() => {
    if (isTor) cancelTor();
    else if (isCodeExchange) cancelCode();
    else cancelPin();
    pendingOfferRef.current = null;
    discardPendingPin();
    setTorAddress(null);
    setRoute('none');
    setStartError(null);
  }, [
    isTor,
    isCodeExchange,
    cancelTor,
    cancelCode,
    cancelPin,
    discardPendingPin,
  ]);

  const handleReset = useCallback(() => {
    if (isTor) resetTor();
    else if (isCodeExchange) resetCode();
    else resetPin();
    pendingOfferRef.current = null;
    discardPendingPin();
    setTorAddress(null);
    setRoute('none');
    setStartError(null);
  }, [isTor, isCodeExchange, resetTor, resetCode, resetPin, discardPendingPin]);

  const handleDownload = useCallback(() => {
    if (receivedContent) {
      downloadFile(
        receivedContent.data,
        receivedContent.fileName,
        receivedContent.mimeType,
      );
    }
  }, [receivedContent]);

  const isActive =
    state.status !== 'idle' &&
    state.status !== 'error' &&
    state.status !== 'complete';
  const answerData = isCodeExchange ? codeState.answerData : undefined;
  const showAnswerReturn =
    isCodeExchange && answerData && codeState.status === 'showing_answer';

  return (
    <div className="space-y-4 pt-4">
      {awaitingAnonymousBridge && state.status === 'idle' ? (
        <AnonymousReceiveForm
          onSubmit={handleAnonymousBridge}
          onCancel={handleCancel}
        />
      ) : isTor && torAddress && state.status === 'idle' ? (
        <TorReceiveForm
          address={torAddress}
          onSubmit={handleTorPassword}
          onCancel={handleCancel}
        />
      ) : state.status === 'idle' ? (
        <>
          <ReceiveInput
            onSubmit={handleSubmit}
            initialPin={initialPin}
            error={startError}
          />

          <div className="text-xs text-muted-foreground text-center pb-2">
            File data is encrypted before transfer. Relays or STUN may still see
            routing metadata.
          </div>
        </>
      ) : (
        <>
          {/* The offer is already in hand here, so the hook's brief
              "waiting for offer" step has nothing to tell the user. */}
          {state.status !== 'waiting_for_offer' && (
            <TransferStatus
              state={state}
              betweenProgressAndChunks={
                state.status === 'showing_confirmation_code' &&
                confirmationCode ? (
                  <ConfirmationCodeDisplay code={confirmationCode} />
                ) : undefined
              }
            />
          )}

          {/* The receiver's answer, carried back to the sender by hand */}
          {showAnswerReturn && answerData && (
            <AnswerReturn answerData={answerData} />
          )}

          {state.status === 'complete' && receivedContent && (
            <div className="space-y-4">
              <div className="p-6 border rounded-lg bg-muted/50 text-center space-y-3">
                <FileDown className="h-12 w-12 mx-auto text-muted-foreground" />
                <div>
                  <p className="font-medium truncate max-w-[300px] mx-auto">
                    {receivedContent.fileName}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatFileSize(receivedContent.fileSize)} &bull;{' '}
                    {getMimeTypeDescription(receivedContent.mimeType)}
                  </p>
                </div>
                <Button
                  onClick={handleDownload}
                  className="w-full max-w-[200px] bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download File
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            {isActive && (
              <Button
                variant="outline"
                onClick={handleCancel}
                className="flex-1"
              >
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            )}

            {(state.status === 'complete' || state.status === 'error') && (
              <Button
                variant="outline"
                onClick={handleReset}
                className="flex-1"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Receive Another
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
