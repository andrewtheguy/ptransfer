import { AlertCircle, Check, Copy, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PIN_ROTATION_MS, PIN_WAIT_TIMEOUT_MS } from '@/lib/crypto';
import { generateTextQRCode } from '@/lib/qr-utils';
import { buildPinUrl } from '@/lib/receive-link';

const QR_WIDTH = 220;

interface PinDisplayProps {
  /** The currently active PIN; rotates every PIN_ROTATION_MS. */
  pin: string;
  /** Called when the wait backstop (PIN_WAIT_TIMEOUT_MS) elapses. */
  onExpire: () => void;
  /**
   * Mints and publishes a fresh PIN immediately, invalidating previously
   * shown PINs. The button is hidden when not provided.
   */
  onRefresh?: () => Promise<void> | void;
}

export function PinDisplay({ pin, onExpire, onRefresh }: PinDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(
    Math.ceil(PIN_WAIT_TIMEOUT_MS / 1000),
  );
  const [rotationPercentage, setRotationPercentage] = useState(100);
  const [rotationSecondsLeft, setRotationSecondsLeft] = useState(
    Math.ceil(PIN_ROTATION_MS / 1000),
  );

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const onExpireRef = useRef(onExpire);
  // Start of the overall wait window (first mount) and of the current PIN's
  // rotation period (reset whenever the pin prop changes).
  const windowStartRef = useRef<number | null>(null);
  const rotationStartRef = useRef<number>(0);

  // Keep onExpire ref up to date
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pin restarts the rotation countdown by design
  useEffect(() => {
    rotationStartRef.current = performance.now();
  }, [pin]);

  useEffect(() => {
    mountedRef.current = true;
    if (windowStartRef.current === null) {
      windowStartRef.current = performance.now();
    }

    const tick = () => {
      if (!mountedRef.current) return;

      const now = performance.now();
      const windowStart = windowStartRef.current ?? now;
      const remainingMs = Math.max(
        0,
        PIN_WAIT_TIMEOUT_MS - (now - windowStart),
      );
      const rotationRemainingMs = Math.max(
        0,
        PIN_ROTATION_MS - (now - rotationStartRef.current),
      );

      setTimeRemaining(Math.ceil(remainingMs / 1000));
      setRotationPercentage((rotationRemainingMs / PIN_ROTATION_MS) * 100);
      setRotationSecondsLeft(Math.ceil(rotationRemainingMs / 1000));

      if (remainingMs <= 0) {
        onExpireRef.current();
        return;
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);

    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Regenerate whenever the PIN changes, so rotation and "Generate a new PIN"
  // both leave a scannable code for the PIN currently on screen.
  useEffect(() => {
    let active = true;
    setQrUrl(null);
    setQrFailed(false);

    generateTextQRCode(buildPinUrl(window.location.origin, pin), {
      width: QR_WIDTH,
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (active) setQrUrl(url);
      })
      .catch((err) => {
        // The QR only saves the receiver some typing; the PIN below it is the
        // real handoff, so a failure here just drops the code rather than
        // leaving a spinner running forever.
        console.error('Failed to generate PIN QR code:', err);
        if (active) setQrFailed(true);
      });

    return () => {
      active = false;
    };
  }, [pin]);

  const handleCopy = useCallback(async () => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    try {
      await navigator.clipboard.writeText(pin);
      if (!mountedRef.current) return;

      setError(false);
      setCopied(true);
      timeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setCopied(false);
        }
      }, 2000);
    } catch {
      if (!mountedRef.current) return;

      setError(true);
      setCopied(false);
      timeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setError(false);
        }
      }, 2000);
    }
  }, [pin]);

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      if (mountedRef.current) {
        setRefreshing(false);
      }
    }
  }, [onRefresh, refreshing]);

  const rotationCountdown = `${Math.floor(rotationSecondsLeft / 60)}:${String(
    rotationSecondsLeft % 60,
  ).padStart(2, '0')}`;

  return (
    <div className="flex flex-col gap-4 p-6 rounded-lg bg-muted/50 border">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          Share this PIN with the receiver
        </h3>
        <p className="text-xs text-muted-foreground">
          {qrFailed
            ? 'Read them the PIN, or copy it and send it over.'
            : 'Have them scan the code, or read them the PIN.'}
        </p>
      </div>

      {/* Scannable PIN link: opens the receive page with the PIN filled in */}
      {!qrFailed && (
        <div className="flex justify-center">
          <div className="p-2 bg-white rounded-lg">
            <div
              className="flex items-center justify-center"
              style={{ width: QR_WIDTH, height: QR_WIDTH }}
            >
              {qrUrl ? (
                <img
                  src={qrUrl}
                  alt="QR code linking to the receive page with this PIN"
                  className="block w-full h-auto"
                />
              ) : (
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>
        </div>
      )}

      {/* PIN Display */}
      <div className="flex flex-col gap-2">
        <Input
          type="text"
          value={pin}
          readOnly
          aria-label="PIN"
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
        />

        {/* Rotation progress: time until a fresh PIN replaces this one */}
        <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-600"
            style={{ width: `${rotationPercentage}%` }}
          />
        </div>
        <div className="flex items-center text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <RefreshCw
              className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`}
            />
            New PIN in <span className="font-mono">{rotationCountdown}</span>
          </span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-2">
        <Button variant="default" className="w-full" onClick={handleCopy}>
          {copied ? (
            <>
              <Check className="h-4 w-4 mr-2" />
              Copied!
            </>
          ) : error ? (
            <>
              <AlertCircle className="h-4 w-4 mr-2" />
              Failed to copy
            </>
          ) : (
            <>
              <Copy className="h-4 w-4 mr-2" />
              Copy PIN
            </>
          )}
        </Button>
        {onRefresh && (
          <div className="space-y-1.5">
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? 'Generating new PIN...' : 'Generate a new PIN'}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Replaces this PIN immediately, invalidates previously shown PINs,
              and restarts the 2-minute countdown.
            </p>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Case sensitive. Share it over a channel you trust.
      </p>

      {/* The PIN is protocol, not a page feature: any implementation of the
          interop protocol can claim it, so say so rather than let the QR
          imply a browser is required. */}
      <p className="text-xs text-muted-foreground text-center">
        The receiver can use this site or the companion CLI — running{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">
          ptransfer
        </code>{' '}
        and choosing Receive takes the same PIN.
      </p>

      {/* Quiet resource backstop, not a security deadline: rotation already
          caps each code's life, so there is no urgency to surface here. */}
      <p className="text-xs text-muted-foreground/70 text-center">
        Waiting stops automatically in{' '}
        {timeRemaining >= 60
          ? `about ${Math.ceil(timeRemaining / 60)} min`
          : 'less than a minute'}{' '}
        if no one connects.
      </p>

      <p className="text-xs text-muted-foreground">
        After the receiver enters this PIN they will see a confirmation code.
        Ask them for it — nothing is sent until you enter it here.
      </p>
    </div>
  );
}
