import { Check, Copy, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { generateTextQRCode } from '@/lib/qr-utils';
import { buildOnionUrl } from '@/lib/receive-link';

const QR_WIDTH = 220;

interface TorAddressDisplayProps {
  /** `<address>.onion` — the exact string the receiver must enter. */
  address: string;
  /** The one-time password: 11 secret data characters plus a checksum. */
  password: string;
}

/**
 * The sender's half of the Tor rendezvous: an onion address and a one-time
 * password, shown as separate values because the receiver needs both.
 *
 * The QR links to the receive page with the address filled in and nothing
 * else. The receiver enters the one-time password separately, much like the
 * manual confirmation step in PIN Exchange, so scanning the address alone
 * never supplies both credentials.
 */
export function TorAddressDisplay({
  address,
  password,
}: TorAddressDisplayProps) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setQrUrl(null);
    setQrFailed(false);

    generateTextQRCode(buildOnionUrl(window.location.origin, address), {
      width: QR_WIDTH,
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (active) setQrUrl(url);
      })
      .catch((err) => {
        // The QR only saves the receiver 56 characters of typing; the address
        // below it is the real handoff, so a failure here drops the code
        // rather than leaving a spinner running forever.
        console.error('Failed to generate onion address QR code:', err);
        if (active) setQrFailed(true);
      });

    return () => {
      active = false;
    };
  }, [address]);

  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">The receiver needs both of these</p>
        <p className="text-xs text-muted-foreground">
          Send them over any channel you trust. The service answers only while
          this tab is open, and the address dies with it.
        </p>
      </div>

      {/* Scannable address link: opens the receive page with the address
          filled in; the receiver enters the password separately. */}
      {!qrFailed && (
        <div className="flex flex-col items-center gap-1.5">
          <div className="p-2 bg-white rounded-lg">
            <div
              className="flex items-center justify-center"
              style={{ width: QR_WIDTH, height: QR_WIDTH }}
            >
              {qrUrl ? (
                <img
                  src={qrUrl}
                  alt="QR code linking to the receive page with this address"
                  className="block w-full h-auto"
                />
              ) : (
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            Scanning this opens the receive page with the address filled in —
            read them the password separately.
          </p>
        </div>
      )}

      <CopyableValue label="Address" value={address} testId="tor-address" />
      <CopyableValue
        label="Password"
        value={password}
        secret
        testId="tor-password"
      />

      <p className="text-xs text-muted-foreground">
        On the receiving side, scan or paste the address into pTransfer&apos;s
        receive page and the password into the field that appears — or run{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">
          ptransfer tor receive {address}
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
