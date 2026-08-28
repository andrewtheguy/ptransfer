import { Download, FileDown, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCodeReceive } from '@/hooks/use-code-receive';
import { usePinReceive } from '@/hooks/use-pin-receive';
import { useTorReceive } from '@/hooks/use-tor-receive';
import { isAnonymousOffer, parseMutualPayload } from '@/lib/code-signaling';
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
import type { ReceiveInput as ReceiveInputValue } from '@/lib/receive-input';
import { extractOnionFromUrl, extractPinFromUrl } from '@/lib/receive-link';
import { DEFAULT_TOR_BRIDGE, type TorBridge } from '@/lib/tor/client';
import type { PinKeyMaterial } from '@/lib/types';
import {
  AnonymousReceiveForm,
  type AnonymousReceiveMode,
} from './anonymous-receive-form';
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
    setSimulateNoDirect,
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
  // Held from the moment the box hands the offer over until the hook arms its
  // offer step — which, for an anonymous offer, is after the bridge question.
  const pendingOfferRef = useRef<Uint8Array | null>(null);
  // An anonymous PIN's key material, held while the bridge question is
  // answered. The PIN string itself is already gone by then — it is turned
  // into these two values the moment the box hands it over, so nothing is
  // parked here that the transfer would not have held anyway.
  const pendingPinRef = useRef<PinKeyMaterial | null>(null);
  // Which exchange the bridge question on screen belongs to, or null when it
  // is not being asked. Separate from the refs above because they must not
  // drive rendering and PIN material must not reach the render tree.
  const [anonymousBridgeFor, setAnonymousBridgeFor] =
    useState<AnonymousReceiveMode | null>(null);
  // The onion address recognized in the box, while its password is asked for.
  const [torAddress, setTorAddress] = useState<string | null>(null);

  // Every sender QR deep-links here with its value in the fragment — a PIN, or
  // a Tor address whose password is asked for separately. Read it during the
  // first render so the input box can open prefilled.
  const [initialValue, setInitialValue] = useState(
    () =>
      extractPinFromUrl(window.location.href) ??
      extractOnionFromUrl(window.location.href) ??
      undefined,
  );

  // Strip the value back out of the URL so it does not linger in the address
  // bar or browser history.
  useEffect(() => {
    if (!initialValue) return;
    window.history.replaceState(null, '', window.location.pathname);
  }, [initialValue]);

  const isCodeExchange = route === 'code';
  const isTor = route === 'tor';
  const state = isTor ? torState : isCodeExchange ? codeState : pinState;
  const receivedContent = isTor
    ? torContent
    : isCodeExchange
      ? codeContent
      : pinContent;

  // Takes the bridge question off screen unanswered. A PIN parked for it still
  // holds a PAKE scalar; the hook would have wiped it, so this stands in for
  // the hook. A parked offer holds nothing secret, and the callers drop it.
  const dismissBridgeQuestion = useCallback(() => {
    const material = pendingPinRef.current;
    pendingPinRef.current = null;
    setAnonymousBridgeFor(null);
    if (material) wipeBufferSource(material.pakeSecret);
  }, []);

  // Leaving the page with the bridge question still on screen abandons that
  // material too, and nothing else would ever reach it. State is deliberately
  // untouched here: the component is going away, so only the wipe matters.
  useEffect(
    () => () => {
      const material = pendingPinRef.current;
      pendingPinRef.current = null;
      if (material) wipeBufferSource(material.pakeSecret);
    },
    [],
  );

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
      // Spent: a later "Receive Another" must not refill the deep-linked value.
      setInitialValue(undefined);
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
          setAnonymousBridgeFor('pin');
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
        // An offer that asks for the anonymous fallback starts bootstrapping
        // Tor as soon as the hook takes it in, so which bridge to spend those
        // minutes on is asked first — exactly as an anonymous PIN does. A
        // container that will not parse is handed over anyway: rejecting it is
        // the hook's job, and it has a state to report the failure in.
        const parsed = parseMutualPayload(input.payload);
        if (parsed && isAnonymousOffer(parsed)) {
          setAnonymousBridgeFor('code');
          return;
        }
        setRoute('code');
        startReceive({ bridge: DEFAULT_TOR_BRIDGE });
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
      const mode = anonymousBridgeFor;
      setAnonymousBridgeFor(null);
      if (mode === 'code') {
        // The offer is already parked; the effect below hands it over once
        // the hook has armed its offer step.
        setRoute('code');
        startReceive({ bridge });
        return;
      }
      const material = pendingPinRef.current;
      if (!material) return;
      pendingPinRef.current = null;
      void startPinReceive(material, bridge, true);
    },
    [anonymousBridgeFor, startPinReceive, startReceive],
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
    dismissBridgeQuestion();
    setTorAddress(null);
    setRoute('none');
    setStartError(null);
  }, [
    isTor,
    isCodeExchange,
    cancelTor,
    cancelCode,
    cancelPin,
    dismissBridgeQuestion,
  ]);

  const handleReset = useCallback(() => {
    if (isTor) resetTor();
    else if (isCodeExchange) resetCode();
    else resetPin();
    pendingOfferRef.current = null;
    dismissBridgeQuestion();
    setTorAddress(null);
    setRoute('none');
    setStartError(null);
  }, [
    isTor,
    isCodeExchange,
    resetTor,
    resetCode,
    resetPin,
    dismissBridgeQuestion,
  ]);

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
  // Covers the simulated stint too: the hook holds this step, relay fetch and
  // all, until the sender turns up, so the response and its switch stay put.
  const showAnswerReturn =
    isCodeExchange && answerData && codeState.status === 'showing_answer';

  return (
    <div className="space-y-4 pt-4">
      {anonymousBridgeFor && state.status === 'idle' ? (
        <AnonymousReceiveForm
          mode={anonymousBridgeFor}
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
            initialValue={initialValue}
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
            <AnswerReturn
              answerData={answerData}
              relayFallbackAvailable={codeState.relayFallbackAvailable}
              simulateNoDirect={codeState.simulateNoDirect}
              onSimulateNoDirectChange={setSimulateNoDirect}
              fallbackName={
                codeState.anonymousFallback ? 'Tor' : 'the Nostr relays'
              }
              torStatus={codeState.torStatus}
            />
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
