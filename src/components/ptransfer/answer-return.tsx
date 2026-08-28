import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Switch } from '@/components/ui/switch';
import { QRDisplay } from './qr-display';

export interface AnswerReturnProps {
  answerData: Uint8Array;
  /**
   * Whether the sender's code named relays. Without them there is no relay
   * path to fall back to, so the simulation switch is not offered.
   */
  relayFallbackAvailable?: boolean;
  /** Whether the response on screen is the simulated no-direct-route one. */
  simulateNoDirect?: boolean;
  /** Absent once the choice is made and the transfer has moved on. */
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
            <ChevronDown
              className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
            />
            Advanced options
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <label
                  htmlFor="answer-simulate-no-direct"
                  className="flex items-center gap-2 text-sm font-medium cursor-pointer"
                >
                  Simulate no direct connection
                  <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    Testing
                  </span>
                </label>
                <p className="text-xs text-muted-foreground">
                  Rebuilds the response below with none of this device's network
                  routes in it, so the sender has nothing to connect to and both
                  sides take the Nostr relay path instead. It is the response a
                  device behind a hostile NAT would send anyway — this only
                  saves you having to arrange one. Give the sender the rebuilt
                  code, not the one you may already have shown them.
                </p>
              </div>
              <Switch
                id="answer-simulate-no-direct"
                checked={simulateNoDirect}
                onCheckedChange={onSimulateNoDirectChange}
                disabled={!onSimulateNoDirectChange}
                className="mt-0.5"
              />
            </div>
            {simulateNoDirect && (
              <p className="rounded-md border bg-background/60 p-3 text-xs text-muted-foreground">
                The code below is the rebuilt one. This page has already given
                up on a direct connection and is waiting on the relays.
              </p>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}

      <QRDisplay data={answerData} label="Your response" />
    </div>
  );
}
