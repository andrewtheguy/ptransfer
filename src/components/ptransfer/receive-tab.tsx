import { Download, FileDown, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useManualReceive } from '@/hooks/use-manual-receive';
import { useNostrReceive } from '@/hooks/use-nostr-receive';
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
type ReceiveRoute = 'none' | 'auto' | 'manual';

export function ReceiveTab() {
  // Both hooks must be called unconditionally (React rules); the route picks
  // which one's state the UI reads.
  const {
    state: nostrState,
    receivedContent: nostrContent,
    confirmationCode,
    receive,
    cancel: cancelNostr,
    reset: resetNostr,
  } = useNostrReceive();
  const {
    state: manualState,
    receivedContent: manualContent,
    startReceive,
    submitOffer,
    cancel: cancelManual,
    reset: resetManual,
  } = useManualReceive();

  const [route, setRoute] = useState<ReceiveRoute>('none');
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

  const isManual = route === 'manual';
  const state = isManual ? manualState : nostrState;
  const receivedContent = isManual ? manualContent : nostrContent;

  const handleSubmit = useCallback(
    async (input: ReceiveInputValue) => {
      // Spent: a later "Receive Another" must not refill the deep-link PIN.
      setInitialPin(undefined);
      setStartError(null);

      if (input.kind === 'pin') {
        setRoute('auto');
        try {
          // The hook wipes the scalar once its PAKE runs are done.
          const pakeSecret = await derivePakeSecret(input.pin);
          await receive({ pakeSecret, locator: getPinLocator(input.pin) });
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
        setRoute('manual');
        startReceive();
      }
      // 'offer-chunk' never reaches here: the scanner reassembles chunks, and
      // the paste box redirects a single chunk link to the Scan tab.
    },
    [receive, startReceive],
  );

  // submitOffer is a no-op until doReceive has armed its offer step, so hand
  // the offer over once the hook reports it is waiting.
  useEffect(() => {
    if (route !== 'manual') return;
    if (manualState.status !== 'waiting_for_offer') return;
    const payload = pendingOfferRef.current;
    if (!payload) return;
    pendingOfferRef.current = null;
    void submitOffer(payload);
  }, [route, manualState.status, submitOffer]);

  const handleCancel = useCallback(() => {
    if (isManual) cancelManual();
    else cancelNostr();
    pendingOfferRef.current = null;
    setRoute('none');
    setStartError(null);
  }, [isManual, cancelManual, cancelNostr]);

  const handleReset = useCallback(() => {
    if (isManual) resetManual();
    else resetNostr();
    pendingOfferRef.current = null;
    setRoute('none');
    setStartError(null);
  }, [isManual, resetManual, resetNostr]);

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
  const answerData = isManual ? manualState.answerData : undefined;
  const showAnswerReturn =
    isManual && answerData && manualState.status === 'showing_answer';

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
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
