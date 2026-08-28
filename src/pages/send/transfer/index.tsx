import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnswerInput } from '@/components/ptransfer/answer-input';
import { ConfirmationCodeInput } from '@/components/ptransfer/confirmation-code-input';
import { MultiQRDisplay } from '@/components/ptransfer/multi-qr-display';
import { NostrRelayStatsPanel } from '@/components/ptransfer/nostr-relay-stats';
import { PinDisplay } from '@/components/ptransfer/pin-display';
import { TorAddressDisplay } from '@/components/ptransfer/tor-address-display';
import { TransferStatus } from '@/components/ptransfer/transfer-status';
import { Button } from '@/components/ui/button';
import { useSend } from '@/contexts/send-context';
import { type UseCodeSendReturn, useCodeSend } from '@/hooks/use-code-send';
import { type UsePinSendReturn, usePinSend } from '@/hooks/use-pin-send';
import { type UseTorSendReturn, useTorSend } from '@/hooks/use-tor-send';
import {
  archiveTimestamp,
  createZipTransferSource,
  getArchiveBaseName,
} from '@/lib/folder-utils';
import { testRelayAvailability } from '@/lib/nostr';
import { DEFAULT_TOR_BRIDGE } from '@/lib/tor/client';
import {
  createFileTransferSource,
  type TransferSource,
} from '@/lib/transfer-source';

type TransferStep =
  | 'checking'
  | 'ready'
  | 'active'
  | 'complete'
  | 'error'
  | 'pin_unavailable';

// Discriminated union for type-safe hook access
type ActiveHook =
  | { type: 'pin'; hook: UsePinSendReturn }
  | { type: 'code'; hook: UseCodeSendReturn }
  | { type: 'tor'; hook: UseTorSendReturn };

export function SendTransferPage() {
  const navigate = useNavigate();
  const { config, setConfig, clearConfig } = useSend();

  const [step, setStep] = useState<TransferStep>('checking');
  const [transferSource, setTransferSource] = useState<TransferSource | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry: the preparation effect keys off it so a retry that leaves
  // the config untouched still schedules a fresh attempt instead of sitting in
  // 'checking' forever.
  const [attempt, setAttempt] = useState(0);

  // Hooks for transfer
  const pinHook = usePinSend();
  const codeHook = useCodeSend();
  const torHook = useTorSend(config?.torBridge ?? DEFAULT_TOR_BRIDGE);

  const startedRef = useRef(false);

  // Determine which hook to use based on config with discriminated union
  const transferMode = config?.transferMode ?? 'code';
  const isPinExchange = transferMode === 'pin';
  const activeHook: ActiveHook = useMemo(() => {
    if (transferMode === 'pin') return { type: 'pin', hook: pinHook };
    if (transferMode === 'tor') return { type: 'tor', hook: torHook };
    return { type: 'code', hook: codeHook };
  }, [transferMode, pinHook, codeHook, torHook]);

  // Extract common state from active hook
  const state = activeHook.hook.state;
  const cancel = activeHook.hook.cancel;

  // PIN Exchange-specific properties (type-safe access)
  const pin = activeHook.type === 'pin' ? activeHook.hook.pin : null;
  const refreshPin =
    activeHook.type === 'pin' ? activeHook.hook.refreshPin : undefined;
  const submitConfirmationCode =
    activeHook.type === 'pin'
      ? activeHook.hook.submitConfirmationCode
      : undefined;

  // Tor-specific properties: the rendezvous pair this tab is publishing.
  const onionAddress =
    activeHook.type === 'tor' ? activeHook.hook.onionAddress : null;
  const torPassword =
    activeHook.type === 'tor' ? activeHook.hook.password : null;

  // Code Exchange-specific properties (type-safe access via discriminated union)
  const codeState = activeHook.type === 'code' ? activeHook.hook.state : null;
  const offerData = codeState?.offerData;
  const submitAnswer =
    activeHook.type === 'code' ? activeHook.hook.submitAnswer : undefined;

  // Redirect if no config
  useEffect(() => {
    if (!config) {
      void navigate('/', { replace: true });
    }
  }, [config, navigate]);

  // Prepare the direct file or lazy ZIP source
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger — Retry leaves the config as it is, so nothing else here would change
  useEffect(() => {
    if (!config || startedRef.current) return;

    let cancelled = false;

    const prepareFile = async () => {
      try {
        // PIN Exchange uses the fixed signaling set. The Code Exchange
        // Nostr-file route resolves its own cached/discovered fallbacks, so a
        // failed fixed-set preflight must not block it before that can run.
        // Anonymous signaling uses neither set: its relays are onion services
        // reached through Tor, so probing the clearnet pool would answer a
        // question it never asks — and would do it from this tab's own IP
        // address, which is the one thing the mode exists to avoid.
        if (config.transferMode === 'pin' && !config.anonymousSignaling) {
          if (cancelled) return;
          setStep('checking');
          const result = await testRelayAvailability();
          if (cancelled) return;
          const available = result.available;
          if (!available) {
            setStep('pin_unavailable');
            return;
          }
        }

        // Prepare file
        const files = config.selectedFiles;

        if (files.length === 0) {
          if (cancelled) return;
          setError('No files selected');
          setStep('error');
          return;
        }

        if (files.length === 1 && !files[0].webkitRelativePath) {
          // A single loose file does not need ZIP packaging.
          if (cancelled) return;
          setTransferSource(createFileTransferSource(files[0]));
          setStep('ready');
        } else {
          // Multiple files, or a folder selection whose structure must be
          // preserved: create a lazy ZIP source. Compression starts only once
          // the data channel is ready and its output is sent immediately.
          if (cancelled) return;
          const archiveName = `${getArchiveBaseName(files)}_${archiveTimestamp()}`;
          setTransferSource(createZipTransferSource(files, archiveName));
          setStep('ready');
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : 'Failed to prepare files',
        );
        setStep('error');
      }
    };

    void prepareFile();

    return () => {
      cancelled = true;
    };
  }, [config, attempt]);

  // Start transfer when file is ready
  useEffect(() => {
    if (step !== 'ready' || !transferSource || !config || startedRef.current)
      return;

    startedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: sync step state when starting transfer
    setStep('active');

    if (activeHook.type === 'pin') {
      void activeHook.hook.send(transferSource, {
        anonymous: config.anonymousSignaling,
        bridge: config.torBridge,
      });
    } else if (activeHook.type === 'code') {
      void activeHook.hook.send(transferSource, {
        anonymousRelay: config.anonymousRelay,
        bridge: config.torBridge,
      });
    } else {
      void activeHook.hook.send(transferSource);
    }
  }, [step, transferSource, config, activeHook]);

  // Track completion - sync local step with hook state
  // Only apply state changes when transfer is active to avoid race conditions
  // after cancellation (handleSwitchToCode, handleRetry set startedRef to false)
  useEffect(() => {
    if (!startedRef.current) return;

    if (state.status === 'complete') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional: sync step with hook completion
      setStep('complete');
    } else if (state.status === 'error') {
      // TypeScript narrows state to TransferStateError, so message is required
      setError(state.message);
      setStep('error');
    }
  }, [state]);

  const handleCancel = useCallback(() => {
    cancel();
    clearConfig();
    void navigate('/send');
  }, [cancel, clearConfig, navigate]);

  const handleSwitchToCode = useCallback(() => {
    if (!config) return;
    // Cancel any active Nostr transfer before switching modes
    if (startedRef.current) {
      try {
        cancel();
      } catch (err) {
        console.error('Failed to cancel transfer:', err);
      }
    }
    // Update config to Code Exchange and restart the transfer flow.
    startedRef.current = false;
    // `anonymousSignaling` is a PIN Exchange flag, so the switch drops it
    // rather than carrying one no hook downstream would read. Code Exchange's
    // own Tor option is not turned on in its place: this is a rescue from a
    // failed PIN transfer, and it should not silently commit the tab to a
    // bootstrap the user never asked for.
    setConfig({
      ...config,
      transferMode: 'code',
      anonymousSignaling: false,
      anonymousRelay: false,
    });
    setStep('checking');
    setError(null);
  }, [config, setConfig, cancel]);

  const handleRetry = useCallback(() => {
    // Cancel any in-flight transfer before retrying
    if (startedRef.current) {
      try {
        cancel();
      } catch (err) {
        console.error('Failed to cancel transfer:', err);
      }
    }
    startedRef.current = false;
    setStep('checking');
    setError(null);
    setAttempt((value) => value + 1);
  }, [cancel]);

  const handleSendAnother = useCallback(() => {
    cancel();
    clearConfig();
    void navigate('/send');
  }, [cancel, clearConfig, navigate]);

  if (!config) {
    return null;
  }

  // Render based on step
  return (
    <div className="space-y-6">
      {/* Checking Nostr availability */}
      {step === 'checking' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Checking connection...</p>
        </div>
      )}

      {/* Nostr unavailable */}
      {step === 'pin_unavailable' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                Unable to connect to relay servers
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                PIN Exchange is temporarily unavailable. Switch to Code Exchange
                or retry the connection.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSwitchToCode} className="flex-1" size="sm">
              <ArrowLeftRight className="mr-2 h-4 w-4" />
              Switch to Code Exchange
            </Button>
            <Button onClick={handleRetry} variant="outline" size="sm">
              Retry
            </Button>
          </div>
        </div>
      )}

      {/* Active transfer */}
      {step === 'active' && (
        <>
          {/* Code Exchange: showing offer */}
          {activeHook.type === 'code' &&
            offerData &&
            submitAnswer &&
            state.status === 'showing_offer' && (
              <div className="space-y-4">
                {/* Instructions at top */}
                <div className="rounded-lg bg-muted/50 border p-4 space-y-3">
                  <div className="space-y-2">
                    <p className="font-medium">
                      Send your connection data to the receiver
                    </p>
                    <p className="text-sm text-muted-foreground">
                      The data below sets up the connection. Get it to your
                      recipient either way — a QR code and copy/paste work
                      equally well:
                    </p>
                    <ul className="text-sm text-muted-foreground space-y-2">
                      <li>
                        <span className="font-medium text-foreground">
                          QR code:
                        </span>{' '}
                        the receiver scans <strong>any</strong> code below with
                        their camera to get started, then the app guides them
                        through the rest. Codes can be scanned in any order, but
                        all of them must be scanned.
                      </li>
                      <li>
                        <span className="font-medium text-foreground">
                          Copy &amp; paste:
                        </span>{' '}
                        tap <strong>Copy Data</strong> below the codes, then
                        send the copied text to the receiver over any trusted
                        channel (an end-to-end encrypted chat, AirDrop, etc.)
                        for them to paste on their device. If the button
                        doesn&apos;t work, use{' '}
                        <strong>Show text to copy manually</strong> to select
                        and copy the data yourself.
                      </li>
                    </ul>
                    <p className="text-sm text-muted-foreground">
                      Either way, the receiver then sends their response back
                      the same way — scan or paste it below to connect. If a
                      direct connection cannot be made, an eligible encrypted
                      file up to 100 MiB can use the automatic Nostr relay
                      fallback.
                    </p>
                  </div>
                </div>

                {/* Connection data: QR codes + Copy Data button */}
                <MultiQRDisplay data={offerData} />

                {/* Input for receiver's response */}
                <div className="pt-2 border-t">
                  <p className="text-sm font-medium mb-3">
                    Scan or paste receiver's response
                  </p>
                  <AnswerInput onSubmit={submitAnswer} />
                </div>
              </div>
            )}

          {/* Code Exchange: other states (connecting, transferring, etc.) */}
          {activeHook.type === 'code' && state.status !== 'showing_offer' && (
            <TransferStatus state={state} />
          )}

          {/* Tor: transfer progress, with the address pair while waiting */}
          {activeHook.type === 'tor' && (
            <TransferStatus
              state={state}
              betweenProgressAndChunks={
                onionAddress &&
                torPassword &&
                state.status === 'waiting_for_receiver' ? (
                  <TorAddressDisplay
                    address={onionAddress}
                    password={torPassword}
                  />
                ) : undefined
              }
            />
          )}

          {/* PIN Exchange: transfer progress */}
          {isPinExchange && (
            <TransferStatus
              state={state}
              betweenProgressAndChunks={
                pin && state.status === 'waiting_for_receiver' ? (
                  <PinDisplay
                    pin={pin}
                    onExpire={handleCancel}
                    onRefresh={refreshPin}
                  />
                ) : state.status === 'awaiting_confirmation_code' &&
                  submitConfirmationCode ? (
                  <ConfirmationCodeInput onSubmit={submitConfirmationCode} />
                ) : undefined
              }
            />
          )}

          <Button onClick={handleCancel} variant="outline" className="w-full">
            Cancel
          </Button>
        </>
      )}

      {/* Complete */}
      {step === 'complete' && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="rounded-full bg-green-100 dark:bg-green-900/30 p-4">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
            <div className="text-center">
              <p className="font-medium text-lg">Transfer Complete!</p>
              <p className="text-muted-foreground text-sm">
                Your files have been sent successfully.
              </p>
            </div>
          </div>
          {'stats' in state && state.stats && (
            <NostrRelayStatsPanel stats={state.stats} />
          )}
          <Button onClick={handleSendAnother} className="w-full">
            <RotateCcw className="mr-2 h-4 w-4" />
            Send Another
          </Button>
        </div>
      )}

      {/* Error */}
      {step === 'error' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-destructive/10 border border-destructive/30 p-4">
            <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive">Transfer Failed</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
          {'stats' in state && state.stats && (
            <NostrRelayStatsPanel stats={state.stats} />
          )}
          <div className="flex gap-2">
            <Button onClick={handleRetry} className="flex-1">
              Retry
            </Button>
            <Button onClick={handleSendAnother} variant="outline">
              Start Over
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
