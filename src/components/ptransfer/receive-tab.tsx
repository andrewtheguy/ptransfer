import { ChevronDown, Download, FileDown, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { useCodeReceive } from '@/hooks/use-code-receive';
import { usePinReceive } from '@/hooks/use-pin-receive';
import { derivePakeSecret, getPinLocator } from '@/lib/crypto';
import {
  downloadFile,
  formatFileSize,
  getMimeTypeDescription,
} from '@/lib/file-utils';
import { extractPinFromUrl } from '@/lib/pin-link';
import type { ReceiveInput as ReceiveInputValue } from '@/lib/receive-input';
import { AnswerReturn } from './answer-return';
import { ConfirmationCodeDisplay } from './confirmation-code-display';
import { ReceiveInput } from './receive-input';
import { TransferStatus } from './transfer-status';

/**
 * Which exchange the receiver's input turned out to belong to. Chosen from what
 * they pasted or scanned rather than asked for up front.
 */
type ReceiveRoute = 'none' | 'pin' | 'code';

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

  const [route, setRoute] = useState<ReceiveRoute>('none');
  // PIN Exchange only: carry the Nostr signaling through the browser Tor
  // client. Each side chooses it for its own device.
  const [anonymousSignaling, setAnonymousSignaling] = useState(false);
  const [anonymousWebSocketBridge, setAnonymousWebSocketBridge] =
    useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Failures before either hook owns the transfer, which therefore have no
  // state of their own to report through.
  const [startError, setStartError] = useState<string | null>(null);
  // Held between startReceive() and the hook arming its offer step.
  const pendingOfferRef = useRef<Uint8Array | null>(null);

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
  const state = isCodeExchange ? codeState : pinState;
  const receivedContent = isCodeExchange ? codeContent : pinContent;

  const handleSubmit = useCallback(
    async (input: ReceiveInputValue) => {
      // Spent: a later "Receive Another" must not refill the deep-link PIN.
      setInitialPin(undefined);
      setStartError(null);

      if (input.kind === 'pin') {
        setRoute('pin');
        try {
          // The hook wipes the scalar once its PAKE runs are done.
          const pakeSecret = await derivePakeSecret(input.pin);
          await receive(
            { pakeSecret, locator: getPinLocator(input.pin) },
            {
              enabled: anonymousSignaling,
              webSocketBridge: anonymousWebSocketBridge,
            },
          );
        } catch (err) {
          // receive() reports its own failures through state; reaching here
          // means the transfer never started, so hand the box back.
          console.error('Failed to start PIN receive flow:', err);
          setRoute('none');
          setStartError('Could not start the transfer. Please try again.');
        }
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
    [receive, startReceive, anonymousSignaling, anonymousWebSocketBridge],
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

  const handleCancel = useCallback(() => {
    if (isCodeExchange) cancelCode();
    else cancelPin();
    pendingOfferRef.current = null;
    setRoute('none');
    setStartError(null);
  }, [isCodeExchange, cancelCode, cancelPin]);

  const handleReset = useCallback(() => {
    if (isCodeExchange) resetCode();
    else resetPin();
    pendingOfferRef.current = null;
    setRoute('none');
    setStartError(null);
  }, [isCodeExchange, resetCode, resetPin]);

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
      {state.status === 'idle' ? (
        <>
          <ReceiveInput
            onSubmit={handleSubmit}
            initialPin={initialPin}
            error={startError}
          />

          {/* Advanced options */}
          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="rounded-lg border bg-muted/30 p-3"
          >
            <CollapsibleTrigger className="flex w-full items-center gap-1 text-sm font-medium">
              <ChevronDown
                className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
              />
              Advanced options
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <label
                    htmlFor="receive-anonymous-signaling"
                    className="flex items-center gap-2 text-sm font-medium cursor-pointer"
                  >
                    Anonymous signaling
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                      Experimental
                    </span>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Applies to a PIN: routes Nostr signaling through Tor inside
                    your browser so the Nostr relays see a Tor exit instead of
                    your IP address. This starts much more slowly and is less
                    reliable. It does not anonymize the direct WebRTC transfer:
                    the sender and STUN services may still see network metadata.
                    Each person must enable this option on their own device to
                    protect both sides.
                  </p>
                </div>
                <Switch
                  id="receive-anonymous-signaling"
                  checked={anonymousSignaling}
                  onCheckedChange={setAnonymousSignaling}
                  className="mt-0.5"
                />
              </div>
              {anonymousSignaling && (
                <div className="flex items-start gap-3 border-l-2 pl-3">
                  <input
                    id="receive-anonymous-websocket-bridge"
                    type="checkbox"
                    checked={anonymousWebSocketBridge}
                    onChange={(event) =>
                      setAnonymousWebSocketBridge(event.target.checked)
                    }
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
                  />
                  <div className="space-y-1">
                    <label
                      htmlFor="receive-anonymous-websocket-bridge"
                      className="cursor-pointer text-sm font-medium"
                    >
                      Reach Tor over WebSocket instead of WebRTC
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Connects straight to the Snowflake bridge over a
                      WebSocket, skipping the broker, STUN, and the volunteer
                      WebRTC proxy. It often starts faster and works where
                      WebRTC is blocked, but it always contacts the same Tor
                      Project address, so it is easier to block and no volunteer
                      proxy sits between you and the bridge.
                    </p>
                  </div>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>

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
