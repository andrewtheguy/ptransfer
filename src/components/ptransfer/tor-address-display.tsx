import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';

interface TorAddressDisplayProps {
  /** `<address>.onion:<port>` — the exact string the receiver must enter. */
  address: string;
  /** The one-time password, all 12 characters of it secret. */
  password: string;
}

/**
 * The sender's half of the Tor rendezvous: an onion address and a one-time
 * password, shown together because the receiver needs both and neither is
 * useful alone.
 *
 * They are deliberately not combined into one string or one QR code. The
 * address is what a receiver types into ptransfer-cli's `tor receive`, and
 * splitting the two is what lets them travel by different routes if the sender
 * wants that — the password is the only thing here worth guarding.
 */
export function TorAddressDisplay({
  address,
  password,
}: TorAddressDisplayProps) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">The receiver needs both of these</p>
        <p className="text-xs text-muted-foreground">
          Send them over any channel you trust. The service answers only while
          this tab is open, and the address dies with it.
        </p>
      </div>

      <CopyableValue label="Address" value={address} testId="tor-address" />
      <CopyableValue
        label="Password"
        value={password}
        secret
        testId="tor-password"
      />

      <p className="text-xs text-muted-foreground">
        On the receiving side, paste the address into pTransfer&apos;s receive
        page and the password into the field that appears — or run{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">
          ptransfer tor receive {address.split(':')[0]}
        </code>{' '}
        and enter the password when prompted.
      </p>
    </div>
  );
}

interface CopyableValueProps {
  label: string;
  value: string;
  secret?: boolean;
  /** Handle for the live interop test, which reads the pair off the page. */
  testId: string;
}

function CopyableValue({ label, value, secret, testId }: CopyableValueProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  }, [value]);

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code
          data-testid={testId}
          className={`flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-xs ${
            secret ? 'tracking-[0.2em]' : 'break-all'
          }`}
        >
          {value}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copy()}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-600" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
