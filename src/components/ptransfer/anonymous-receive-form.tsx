import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DEFAULT_TOR_BRIDGE, type TorBridge } from '@/lib/tor/client';
import { TorBridgeChoice } from './tor-bridge-choice';

interface AnonymousReceiveFormProps {
  onSubmit: (bridge: TorBridge) => void;
  onCancel: () => void;
}

/**
 * What the receiver sees when the PIN it was handed turns out to be an
 * anonymous-signaling one.
 *
 * There is nothing to ask about the mode itself — the PIN's length already
 * settled that the sender is waiting on the onion relay pool, and connecting
 * anywhere else would simply find nobody. The one open question is which
 * Snowflake bridge this device reaches Tor through, and it is worth asking
 * before starting rather than after: a bootstrap costs minutes, and a person
 * on a network that blocks the fixed endpoint should not have to spend them
 * twice to discover it.
 */
export function AnonymousReceiveForm({
  onSubmit,
  onCancel,
}: AnonymousReceiveFormProps) {
  const [bridge, setBridge] = useState<TorBridge>(DEFAULT_TOR_BRIDGE);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          Anonymous signaling
          <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Experimental
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          This PIN was made with anonymous signaling on, so the handshake runs
          through Tor inside your browser to relays run as onion services — no
          relay sees your IP address, or the sender's. Starting takes a while,
          especially the first time, and it fails more often than an ordinary
          PIN. The file itself still arrives over a direct WebRTC connection,
          which Tor does not cover: the sender and the STUN services see the
          same network metadata as always.
        </p>
      </div>

      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <p className="text-sm font-medium">How this tab reaches Tor</p>
        <TorBridgeChoice
          value={bridge}
          onChange={setBridge}
          idPrefix="receive-anonymous-bridge"
        />
        <p className="text-xs text-muted-foreground">
          The sender's choice does not have to match yours: the two only meet at
          the relay, inside the Tor network.
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
          Connect over Tor
        </Button>
      </div>
    </div>
  );
}
