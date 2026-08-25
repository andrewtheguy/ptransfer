import {
  AlertCircle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ClipboardPaste,
  Download,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  classifyReceiveText,
  looksLikePin,
  type ReceiveInput as ReceiveInputValue,
} from '@/lib/receive-input';
import { isMobileDevice } from '@/lib/utils';
import { QRScanner, type ScanResult } from './qr-scanner';

/** How long a PIN may sit unattended in the box before it is wiped. */
const PIN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

interface ReceiveInputProps {
  onSubmit: (input: ReceiveInputValue) => void;
  /** Prefills the box from a scanned PIN link, opening on the Paste tab. */
  initialPin?: string;
  disabled?: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * The single receive surface: scan whatever the sender showed you, or paste
 * whatever they sent you. Which mode that implies is inferred from the input
 * rather than asked for up front.
 */
export function ReceiveInput({
  onSubmit,
  initialPin,
  disabled,
}: ReceiveInputProps) {
  const [value, setValue] = useState(initialPin ?? '');
  const [error, setError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<'scan' | 'paste'>(
    initialPin ? 'paste' : 'scan',
  );
  // The Scan tab is the landing view, so the camera stays behind a click gate;
  // otherwise merely opening /receive would prompt for camera permission.
  const [scanStarted, setScanStarted] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [pinExpired, setPinExpired] = useState(false);

  const scanActionVerb = isMobileDevice() ? 'Tap' : 'Click';
  const classified = useMemo(() => classifyReceiveText(value), [value]);
  const pinLike = looksLikePin(value);

  // Wipe an unattended PIN. Only PINs: an offer code is not a secret, and
  // clearing one out from under someone mid-paste would just lose their work.
  useEffect(() => {
    // Derived from value here rather than read off pinLike, so that editing the
    // PIN restarts the countdown: it tracks inactivity, not the PIN's age.
    if (!looksLikePin(value)) {
      setTimeRemaining(0);
      return;
    }

    setPinExpired(false);
    setTimeRemaining(Math.ceil(PIN_INACTIVITY_TIMEOUT_MS / 1000));
    const deadline = Date.now() + PIN_INACTIVITY_TIMEOUT_MS;

    const intervalId = setInterval(() => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        clearInterval(intervalId);
        setValue('');
        setTimeRemaining(0);
        setPinExpired(true);
        return;
      }
      setTimeRemaining(Math.ceil(remainingMs / 1000));
    }, 1000);

    return () => clearInterval(intervalId);
  }, [value]);

  const handlePasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setValue(text);
      setError(null);
      setPinExpired(false);
    } catch (err) {
      console.error('Failed to paste:', err);
      setError('Failed to read clipboard');
    }
  }, []);

  const handleSubmit = useCallback(() => {
    if (!value.trim()) {
      setError('Paste the PIN or code the sender sent you.');
      return;
    }

    if (!classified) {
      setError(
        pinLike
          ? 'Invalid PIN — check for typos.'
          : 'Not a PIN or sender code. Check that you copied the whole thing.',
      );
      return;
    }

    if (classified.kind === 'offer-chunk') {
      setError(
        "That link is one of the sender's QR codes — use the Scan tab, or paste the text they copied.",
      );
      return;
    }

    setError(null);
    setPinExpired(false);
    // Drop the PIN out of the DOM the moment it is handed on.
    setValue('');
    onSubmit(classified);
  }, [classified, onSubmit, pinLike, value]);

  const handleScan = useCallback(
    (result: ScanResult) => {
      setError(null);
      setPinExpired(false);
      setValue('');
      onSubmit(
        result.kind === 'pin'
          ? { kind: 'pin', pin: result.pin }
          : { kind: 'offer', payload: result.data },
      );
    },
    [onSubmit],
  );

  const handleScanError = useCallback((err: string) => {
    // Only show persistent errors, not transient scan failures
    if (err.includes('denied') || err.includes('unavailable')) {
      setError(err);
    }
  }, []);

  const handleInputModeChange = useCallback((next: 'scan' | 'paste') => {
    setError(null);
    setInputMode(next);
    if (next !== 'scan') {
      setScanStarted(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Scan the sender's QR code, or paste the PIN or code they sent you.
      </p>

      <Tabs
        value={inputMode}
        onValueChange={(v) => handleInputModeChange(v as 'scan' | 'paste')}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="scan" disabled={disabled}>
            <Camera className="h-4 w-4 mr-2" />
            Scan
          </TabsTrigger>
          <TabsTrigger value="paste" disabled={disabled}>
            <ClipboardPaste className="h-4 w-4 mr-2" />
            Paste
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="mt-3">
          {scanStarted ? (
            <QRScanner
              mode="receive"
              onScan={handleScan}
              onError={handleScanError}
              disabled={disabled}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setScanStarted(true);
              }}
              disabled={disabled}
              className="w-full rounded-lg border border-dashed p-6 text-center cursor-pointer transition-colors hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Camera className="h-6 w-6 mx-auto mb-2" />
              <p className="text-base font-medium">Start scanning</p>
              <p className="text-sm text-muted-foreground mt-1">
                {`${scanActionVerb} anywhere in this area to start the camera scanner.`}
              </p>
            </button>
          )}
        </TabsContent>

        <TabsContent value="paste" className="mt-3 space-y-2">
          <Textarea
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
              setPinExpired(false);
            }}
            placeholder="Paste the PIN or the sender's code here..."
            className="min-h-[100px] font-mono text-xs"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="PIN or sender code"
            disabled={disabled}
          />

          {classified?.kind === 'pin' && (
            <p className="text-xs text-green-600 flex items-center">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              PIN detected
            </p>
          )}
          {classified?.kind === 'offer' && (
            <p className="text-xs text-green-600 flex items-center">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Sender's code detected
            </p>
          )}
          {classified?.kind === 'offer-chunk' && (
            <p className="text-xs text-amber-600 flex items-center">
              <AlertCircle className="h-3 w-3 mr-1" />
              That's one of the sender's QR links — use the Scan tab instead.
            </p>
          )}
          {!classified && pinLike && (
            <p className="text-xs text-destructive flex items-center">
              <AlertCircle className="h-3 w-3 mr-1" />
              Invalid PIN — check for typos
            </p>
          )}

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

          {error && (
            <p className="text-xs text-destructive flex items-center">
              <AlertCircle className="h-3 w-3 mr-1" />
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePasteFromClipboard}
              disabled={disabled}
              className="flex-1"
            >
              <ClipboardPaste className="h-4 w-4 mr-2" />
              Paste from Clipboard
            </Button>

            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
              className="flex-1 bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
            >
              <Download className="h-4 w-4 mr-2" />
              Receive
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {inputMode === 'scan' && error && (
        <p className="text-xs text-destructive flex items-center">
          <AlertCircle className="h-3 w-3 mr-1" />
          {error}
        </p>
      )}

      <Collapsible className="space-y-2">
        <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
          <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
          What am I pasting?
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">
              A short 12-character PIN
            </span>{' '}
            means the sender chose PIN Exchange. Relays carry the handshake and
            the PIN authenticates it; a confirmation code appears here for you
            to read back to them, and nothing is sent until it matches.
          </p>
          <p>
            <span className="font-medium text-foreground">
              A long block of text, or a grid of QR codes,
            </span>{' '}
            means they chose Code Exchange. Nothing about the handshake touches
            a relay — you hand a response code back the same way you got theirs.
            If a direct connection cannot be made, an eligible encrypted file up
            to 100 MiB can use the automatic Nostr relay fallback.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
