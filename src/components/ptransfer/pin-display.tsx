import { AlertCircle, Check, Copy, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PIN_ROTATION_MS, PIN_WAIT_TIMEOUT_MS } from '@/lib/crypto';

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
      <h3 className="text-sm font-medium">Share this PIN with the receiver</h3>

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
