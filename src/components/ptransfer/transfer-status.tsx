import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  KeyRound,
  Loader2,
  Radio,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { OFFLINE_QR_TRANSFER_URL } from '@/lib/constants';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferState } from '@/lib/nostr';
import { NostrRelayStatsPanel } from './nostr-relay-stats';

interface TransferStatusProps {
  state: TransferState;
  betweenProgressAndChunks?: React.ReactNode;
}

export function TransferStatus({
  state,
  betweenProgressAndChunks,
}: TransferStatusProps) {
  const [showDebug, setShowDebug] = useState(false);

  if (state.status === 'idle') return null;

  const getIcon = () => {
    switch (state.status) {
      case 'connecting':
      case 'waiting_for_receiver':
      case 'transferring':
      case 'receiving':
      case 'preparing':
      case 'discovering_relays':
      case 'uploading':
      case 'fetching':
      // Live Nostr relay: the code is on screen while the transfer runs.
      case 'showing_payload':
        return <Loader2 className="h-4 w-4 animate-spin" />;
      // Both sides of the confirmation-code step are blocked on a human
      // reading a code aloud, not on the network — a spinner would misreport
      // that as progress.
      case 'showing_confirmation_code':
      case 'awaiting_confirmation_code':
        return <KeyRound className="h-4 w-4" />;
      case 'complete':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'error':
        return <XCircle className="h-4 w-4 text-destructive" />;
      default:
        return <Radio className="h-4 w-4" />;
    }
  };

  const getVariant = (): 'default' | 'destructive' => {
    return state.status === 'error' ? 'destructive' : 'default';
  };

  const progressPercent =
    state.progress && state.progress.total > 0
      ? (state.progress.current / state.progress.total) * 100
      : 0;

  // Show relays whenever Nostr was used (for debugging)
  const showRelays = state.currentRelays && state.currentRelays.length > 0;

  // Suggest the offline QR transfer app when a direct P2P connection failed.
  const showOfflineQrSuggestion =
    state.status === 'error' && state.connectionFailed === true;

  return (
    <div className="space-y-3">
      <Alert variant={getVariant()}>
        {getIcon()}
        <AlertDescription>
          {state.message || state.status}
          {state.useWebRTC && (
            <span className="text-xs text-muted-foreground ml-2">(P2P)</span>
          )}
        </AlertDescription>
      </Alert>

      {showOfflineQrSuggestion && (
        <Alert>
          <ExternalLink className="h-4 w-4" />
          <AlertDescription>
            <span>
              A direct peer-to-peer connection couldn't be established. If both
              devices are side by side, you can transfer the file offline with
              animated QR codes using{' '}
              <a
                href={OFFLINE_QR_TRANSFER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline underline-offset-2"
              >
                Secure QR Transfer
              </a>
              .
            </span>
          </AlertDescription>
        </Alert>
      )}

      {showRelays && (
        <div className="text-xs space-y-1">
          <button
            type="button"
            onClick={() => setShowDebug(!showDebug)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showDebug ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span>Debug info</span>
          </button>
          {showDebug && (
            <div className="pl-4 space-y-1">
              <p className="font-medium text-muted-foreground">
                Connected Relays: {state.currentRelays!.length}
                {state.totalRelays !== undefined && ` / ${state.totalRelays}`}
              </p>
              <ul className="space-y-0.5 pl-3">
                {state.currentRelays!.map((relay) => (
                  <li
                    key={relay}
                    className="text-muted-foreground truncate"
                    title={relay}
                  >
                    • {relay.replace('wss://', '')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {state.progress && state.progress.total > 0 && (
        <div className="space-y-1">
          <Progress value={progressPercent} className="h-2" />
          <p className="text-xs text-muted-foreground text-right">
            {formatFileSize(state.progress.current)} /{' '}
            {formatFileSize(state.progress.total)}
          </p>
        </div>
      )}

      {state.expiresAt !== undefined && state.status !== 'complete' && (
        <ExpiryCountdown expiresAt={state.expiresAt} />
      )}

      {state.stats && <NostrRelayStatsPanel stats={state.stats} />}

      {betweenProgressAndChunks}
    </div>
  );
}

/**
 * Countdown to a NIP-40 expiry timestamp (unix seconds). Isolated so its
 * 1-second tick re-renders only this row.
 */
export function ExpiryCountdown({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const next = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
      setRemaining(next);
      // The countdown never leaves 0 — stop ticking once it gets there.
      if (next === 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <p className="text-xs text-muted-foreground">
      {remaining > 0 ? (
        <>
          Relay copies expire in{' '}
          <span className="font-medium tabular-nums">
            {minutes}:{String(seconds).padStart(2, '0')}
          </span>
        </>
      ) : (
        'Relay copies have expired'
      )}
    </p>
  );
}
