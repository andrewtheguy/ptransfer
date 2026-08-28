import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { QRDisplay } from './qr-display';

export interface AnswerReturnProps {
  answerData: Uint8Array;
  /**
   * Whether the sender's code named relays. Without them there is no relay
   * path to fall back to, so the simulation is not offered.
   */
  relayFallbackAvailable?: boolean;
  /** Whether the response on screen is the simulated no-direct-route one. */
  simulateNoDirect?: boolean;
  onSimulateNoDirectChange?: (value: boolean) => void;
}

/**
 * The receiver's half of the answer step: the QR / copy-paste instructions.
 * The answer only ever reaches the sender through their own scan or paste.
 */
export function AnswerReturn({
  answerData,
  relayFallbackAvailable = false,
  simulateNoDirect = false,
  onSimulateNoDirectChange,
}: AnswerReturnProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-muted/50 border p-4 space-y-2">
        <p className="font-medium">Send your response back to the sender</p>
        <p className="text-sm text-muted-foreground">
          Get your response back to the sender by the QR code below or
          copy/paste the data:
        </p>
        <ul className="text-sm text-muted-foreground space-y-2">
          <li>
            <span className="font-medium text-foreground">QR code:</span> the
            sender scans the code below with the in-app scanner under{' '}
            <strong>Scan or paste receiver's response</strong> on their page.
          </li>
          <li>
            <span className="font-medium text-foreground">
              Copy &amp; paste:
            </span>{' '}
            tap <strong>Copy Data</strong> below the code, then send the copied
            text back to the sender over the same secure channel for them to
            paste. If the button doesn&apos;t work, use{' '}
            <strong>Show text to copy manually</strong> to select and copy the
            response yourself.
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          {simulateNoDirect
            ? 'Keep this page open — the file comes through the relays once the sender has your response.'
            : 'Keep this page open — the transfer connects automatically once the sender has your response.'}
        </p>
      </div>

      {/* Advanced options: only where a relay path exists to fall back to,
          and closed by default. */}
      {relayFallbackAvailable && (
        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          className="rounded-lg border bg-muted/30 p-3"
        >
          <CollapsibleTrigger className="flex w-full items-center gap-1 text-sm font-medium">
            Advanced options
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            <div className="space-y-1">
              <span className="text-sm font-medium">No direct connection</span>
              <p className="text-xs text-muted-foreground">
                {simulateNoDirect
                  ? 'A direct connection to this page can no longer be made, and the code below is the one with none of its network routes in it. Nothing has started yet — the file comes through the Nostr relays once the sender takes the response in. Going back builds a working direct route again.'
                  : "Drops this device's direct connection and builds the response again with none of its network routes in it, so the sender has nothing to connect to and the file comes through the Nostr relays instead. It is the situation a device behind a hostile NAT is in anyway — this only saves you having to arrange one."}
              </p>
              <p className="text-xs text-muted-foreground">
                Either way the whole connection is built from scratch, so the
                code below changes: hand the sender the one on screen now.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={!onSimulateNoDirectChange}
              onClick={() => onSimulateNoDirectChange?.(!simulateNoDirect)}
            >
              {simulateNoDirect
                ? 'Go back to a direct connection'
                : 'Simulate no direct connection'}
            </Button>
          </CollapsibleContent>
        </Collapsible>
      )}

      <QRDisplay data={answerData} label="Your response" />
    </div>
  );
}
