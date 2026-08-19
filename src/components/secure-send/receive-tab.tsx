import {
  ArrowLeftRight,
  Download,
  FileDown,
  KeyRound,
  RotateCcw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useManualReceive } from '@/hooks/use-manual-receive';
import { useNostrReceive } from '@/hooks/use-nostr-receive';
import {
  downloadFile,
  formatFileSize,
  getMimeTypeDescription,
} from '@/lib/file-utils';
import type { PinKeyMaterial } from '@/lib/types';
import { ConfirmationCodeDisplay } from './confirmation-code-display';
import { type PinChangePayload, PinInput, type PinInputRef } from './pin-input';
import { QRDisplay } from './qr-display';
import { QRInput } from './qr-input';
import { TransferStatus } from './transfer-status';

const PIN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PIN_MODE_DESCRIPTION =
  'Most reliable option. Sets up the connection automatically through relays using the PIN the sender shares; the same end-to-end encrypted transfer, without the manual handoff.';
const MANUAL_MODE_DESCRIPTION =
  'You and the sender directly exchange a short signaling payload — by QR code or copy/paste — to establish the transfer. No third-party coordination servers; STUN may be used when internet is available. File data stays encrypted.';

type ReceiveMode = 'pin' | 'scan';

export function ReceiveTab() {
  const [receiveMode, setReceiveMode] = useState<ReceiveMode>('pin');

  // Store PIN in ref to avoid React DevTools exposure
  const pinSecretRef = useRef<PinKeyMaterial | null>(null);
  const pinInputLengthRef = useRef(0);
  const pinInputRef = useRef<PinInputRef>(null);
  const [isPinValid, setIsPinValid] = useState(false);
  const [pinExpired, setPinExpired] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(0);

  // All hooks must be called unconditionally (React rules)
  const nostrHook = useNostrReceive();
  const manualHook = useManualReceive();

  // Determine which hook to use based on mode
  const isManualMode = receiveMode === 'scan';

  const activeHook = isManualMode ? manualHook : nostrHook;

  const { state: rawState, receivedContent, cancel, reset } = activeHook;

  // Get the right receive function based on mode
  // nostrHook has .receive, manualHook does not
  const pinReceive: ((secret: PinKeyMaterial) => Promise<void>) | undefined =
    !isManualMode &&
    'receive' in activeHook &&
    typeof activeHook.receive === 'function'
      ? activeHook.receive
      : undefined;
  const { startReceive, submitOffer } = manualHook;

  // Auto Exchange only: the code the receiver reads out to the sender.
  const confirmationCode = isManualMode ? null : nostrHook.confirmationCode;

  // Use rawState directly for common properties
  const state = rawState;

  // Runtime normalization for manual-mode specific properties
  const rawStateAny = rawState as unknown as Record<string, unknown>;
  const answerData: Uint8Array | undefined =
    rawStateAny.answerData instanceof Uint8Array
      ? rawStateAny.answerData
      : undefined;
  const clipboardData: string | undefined =
    typeof rawStateAny.clipboardData === 'string'
      ? rawStateAny.clipboardData
      : undefined;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinInactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const mountedRef = useRef(true);

  // Clear PIN inactivity timeout and countdown
  const clearPinInactivityTimeout = useCallback(() => {
    if (pinInactivityRef.current) {
      clearTimeout(pinInactivityRef.current);
      pinInactivityRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setTimeRemaining(0);
  }, []);

  // Reset PIN inactivity timeout (called on each PIN change)
  const resetPinInactivityTimeout = useCallback(
    (hasInput: boolean) => {
      clearPinInactivityTimeout();
      setPinExpired(false);

      // Only set timeout if there's some PIN input
      if (hasInput) {
        // Set initial countdown time
        setTimeRemaining(Math.floor(PIN_INACTIVITY_TIMEOUT_MS / 1000));

        // Start countdown interval
        countdownIntervalRef.current = setInterval(() => {
          if (!mountedRef.current) return;
          setTimeRemaining((prev) => Math.max(0, prev - 1));
        }, 1000);

        // Set expiration timeout
        pinInactivityRef.current = setTimeout(() => {
          if (
            mountedRef.current &&
            (pinSecretRef.current || pinInputLengthRef.current > 0)
          ) {
            // Clear PIN due to inactivity
            pinSecretRef.current = null;
            pinInputLengthRef.current = 0;
            setIsPinValid(false);
            pinInputRef.current?.clear();
            setPinExpired(true);
            if (countdownIntervalRef.current) {
              clearInterval(countdownIntervalRef.current);
              countdownIntervalRef.current = null;
            }
            setTimeRemaining(0);
          }
        }, PIN_INACTIVITY_TIMEOUT_MS);
      }
    },
    [clearPinInactivityTimeout],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Clear PIN from memory on unmount
      pinSecretRef.current = null;
      pinInputLengthRef.current = 0;
      const timeoutId = timeoutRef.current;
      const countdownId = countdownIntervalRef.current;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (countdownId) {
        clearInterval(countdownId);
      }
      timeoutRef.current = null;
      countdownIntervalRef.current = null;
      clearPinInactivityTimeout();
    };
  }, [clearPinInactivityTimeout]);

  // Format time remaining as MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const canReceivePin = isPinValid && state.status === 'idle';
  const canReceiveScan = state.status === 'idle';

  const handleReceivePin = async () => {
    const secret = pinSecretRef.current;
    if (canReceivePin && secret && pinReceive) {
      clearPinInactivityTimeout();
      // Clear stored material immediately after retrieving it
      pinSecretRef.current = null;
      pinInputLengthRef.current = 0;
      setIsPinValid(false);
      pinInputRef.current?.clear();
      setPinExpired(false);
      try {
        await pinReceive(secret);
      } catch (err) {
        console.error('Failed to start PIN receive flow:', err);
      }
    }
  };

  const handleReceiveScan = () => {
    if (canReceiveScan) {
      startReceive();
    }
  };

  const handleReset = () => {
    reset();
    clearPinInactivityTimeout();
    // Clear PIN from ref and input
    pinSecretRef.current = null;
    pinInputLengthRef.current = 0;
    setIsPinValid(false);
    pinInputRef.current?.clear();
    setPinExpired(false);
  };

  const handlePinChange = useCallback(
    (payload: PinChangePayload) => {
      const { pakeSecret, locator, isValid, length } = payload;
      pinInputLengthRef.current = length;

      if (isValid && pakeSecret && locator) {
        pinSecretRef.current = { pakeSecret, locator };
        setIsPinValid(true);
      } else {
        pinSecretRef.current = null;
        setIsPinValid(false);
      }

      resetPinInactivityTimeout(length > 0);
    },
    [resetPinInactivityTimeout],
  );

  const handleDownload = () => {
    if (receivedContent) {
      downloadFile(
        receivedContent.data,
        receivedContent.fileName,
        receivedContent.mimeType,
      );
    }
  };

  const isActive =
    state.status !== 'idle' &&
    state.status !== 'error' &&
    state.status !== 'complete';
  const showQRInput = isManualMode && state.status === 'waiting_for_offer';
  const showQRDisplay =
    isManualMode && answerData && state.status === 'showing_answer';

  return (
    <div className="space-y-4 pt-4">
      {state.status === 'idle' ? (
        <>
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
            <p className="text-sm font-medium">Transfer mode</p>
            <RadioGroup
              value={receiveMode}
              onValueChange={(value) => setReceiveMode(value as ReceiveMode)}
              className="gap-2"
            >
              <label
                htmlFor="receive-mode-pin"
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                  receiveMode === 'pin'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/60'
                }`}
              >
                <RadioGroupItem
                  id="receive-mode-pin"
                  value="pin"
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <KeyRound className="h-4 w-4" />
                    Auto Exchange mode
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {PIN_MODE_DESCRIPTION}
                  </p>
                </div>
              </label>

              <label
                htmlFor="receive-mode-qr"
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                  receiveMode === 'scan'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/60'
                }`}
              >
                <RadioGroupItem
                  id="receive-mode-qr"
                  value="scan"
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <ArrowLeftRight className="h-4 w-4" />
                    Manual Exchange mode
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {MANUAL_MODE_DESCRIPTION}
                  </p>
                </div>
              </label>
            </RadioGroup>
          </div>

          {receiveMode === 'pin' ? (
            <>
              {/* Auto Exchange mode */}
              <div className="space-y-2">
                <div className="text-sm font-medium">Enter PIN from sender</div>
                <PinInput
                  ref={pinInputRef}
                  onPinChange={handlePinChange}
                  disabled={isActive}
                />
                {timeRemaining > 0 && (
                  <p className="text-xs text-amber-600 font-medium">
                    PIN will be cleared in {formatTime(timeRemaining)}
                  </p>
                )}
                {pinExpired && (
                  <p className="text-xs text-muted-foreground">
                    PIN cleared due to inactivity. Please re-enter.
                  </p>
                )}
              </div>

              {isPinValid && (
                <p className="text-xs text-muted-foreground">
                  After you receive, a confirmation code appears here. Read it
                  to the sender — the transfer only starts once they enter it.
                </p>
              )}

              <div className="text-xs text-muted-foreground text-center pb-2">
                File data is encrypted before transfer. Relays or STUN may still
                see routing metadata.
              </div>

              <Button
                onClick={handleReceivePin}
                disabled={!canReceivePin}
                className="w-full bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
              >
                <Download className="mr-2 h-4 w-4" />
                Receive
                <span aria-hidden="true" className="ml-2 h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  For{' '}
                  <span className="font-medium text-foreground">
                    Manual Exchange mode
                  </span>{' '}
                  transfers only. Scan or paste the sender's signaling data to
                  receive their content.
                </p>
              </div>

              <Button
                onClick={handleReceiveScan}
                disabled={!canReceiveScan}
                className="w-full bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
              >
                <Download className="mr-2 h-4 w-4" />
                Start Receive
              </Button>
            </>
          )}
        </>
      ) : (
        <>
          <TransferStatus
            state={state}
            betweenProgressAndChunks={
              state.status === 'showing_confirmation_code' &&
              confirmationCode ? (
                <ConfirmationCodeDisplay code={confirmationCode} />
              ) : undefined
            }
          />

          {/* QR Input for receiving offer */}
          {showQRInput && (
            <div className="space-y-4">
              <QRInput
                expectedType="offer"
                label="Scan or paste the sender's code"
                onSubmit={submitOffer}
              />
            </div>
          )}

          {/* Answer display: returned to the sender by QR or copy/paste */}
          {showQRDisplay && answerData && (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted/50 border p-4 space-y-2">
                <p className="font-medium">
                  Send your response back to the sender
                </p>
                <p className="text-sm text-muted-foreground">
                  Get your response back to the sender by the QR code below or
                  copy/paste the data:
                </p>
                <ul className="text-sm text-muted-foreground space-y-2">
                  <li>
                    <span className="font-medium text-foreground">
                      QR code:
                    </span>{' '}
                    the sender scans the code below with their camera.
                  </li>
                  <li>
                    <span className="font-medium text-foreground">
                      Copy &amp; paste:
                    </span>{' '}
                    tap <strong>Copy Data</strong> below the code, then send the
                    copied text back to the sender over the same secure channel
                    for them to paste. If the button doesn&apos;t work, use{' '}
                    <strong>Show text to copy manually</strong> to select and
                    copy the response yourself.
                  </li>
                </ul>
                <p className="text-sm text-muted-foreground">
                  Keep this page open — the transfer connects automatically once
                  the sender has your response.
                </p>
              </div>
              <QRDisplay
                data={answerData}
                clipboardData={clipboardData}
                label="Your response"
              />
            </div>
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
              <Button variant="outline" onClick={cancel} className="flex-1">
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
