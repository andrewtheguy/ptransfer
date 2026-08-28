import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DEFAULT_TOR_BRIDGE, type TorBridge } from '@/lib/tor/client';
import { TorBridgeChoice } from './tor-bridge-choice';

/**
 * Which exchange asked for Tor. Only the explanation differs — what Tor
 * covers is not the same in the two modes, and saying so wrongly would be
 * worse than saying nothing.
 */
export type AnonymousReceiveMode = 'pin' | 'code';

interface AnonymousReceiveFormProps {
  mode: AnonymousReceiveMode;
  onSubmit: (bridge: TorBridge) => void;
  onCancel: () => void;
}

const HEADINGS: Record<AnonymousReceiveMode, string> = {
  pin: 'Anonymous signaling',
  code: 'Anonymous signaling and relay',
};

const CONFIRM_LABELS: Record<AnonymousReceiveMode, string> = {
  pin: 'Connect over Tor',
  // Nothing connects over Tor yet: the next thing on screen is the response
  // to carry back, and a direct connection is tried before Tor is used at all.
  code: 'Continue',
};

/**
 * What the receiver sees when what it was handed turns out to have been made
 * with Tor on.
 *
 * There is nothing to ask about the mode itself — an anonymous PIN's length
 * and an anonymous sender code's own flag each settle that, and the sender is
 * waiting on the onion relay pool either way. The one open question is which
 * Snowflake bridge this device reaches Tor through, and it is worth asking
 * before starting rather than after: a bootstrap costs minutes, and a person
 * on a network that blocks the fixed endpoint should not have to spend them
 * twice to discover it.
 */
export function AnonymousReceiveForm({
  mode,
  onSubmit,
  onCancel,
}: AnonymousReceiveFormProps) {
  const [bridge, setBridge] = useState<TorBridge>(DEFAULT_TOR_BRIDGE);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {HEADINGS[mode]}
          <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Experimental
          </span>
        </p>
        {mode === 'pin' ? (
          <p className="text-xs text-muted-foreground">
            This PIN was made with anonymous signaling on, so the handshake runs
            through Tor inside your browser to relays run as onion services — no
            relay sees your IP address, or the sender's. Starting takes a while,
            especially the first time, and it fails more often than an ordinary
            PIN. The file itself still arrives over a direct WebRTC connection,
            which Tor does not cover: the sender and the STUN services see the
            same network metadata as always.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            This code was made with anonymous signaling and relay on. A direct
            WebRTC connection is still tried first, exactly as always, and Tor
            does not cover it: while it is being attempted, the sender and the
            STUN services see the same network metadata as always. If there is
            no direct route, the file arrives through Tor instead — over an
            onion service the sending page publishes, coordinated over relays
            run as onion services, so no relay sees your IP address or the
            sender's. Your browser starts Tor now rather than then, because that
            is the slow part; expect it to take a while, especially the first
            time.
          </p>
        )}
      </div>

      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <p className="text-sm font-medium">How this tab reaches Tor</p>
        <TorBridgeChoice
          value={bridge}
          onChange={setBridge}
          idPrefix={`receive-anonymous-${mode}-bridge`}
        />
        <p className="text-xs text-muted-foreground">
          The sender's choice does not have to match yours: the two only meet
          inside the Tor network.
        </p>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={onCancel} className="flex-1">
          Back
        </Button>
        <Button
          onClick={() => onSubmit(bridge)}
          className="flex-1 bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
        >
          <Download className="mr-2 h-4 w-4" />
          {CONFIRM_LABELS[mode]}
        </Button>
      </div>
    </div>
  );
}
