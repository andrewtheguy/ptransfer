import { Check, Copy, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { generateTextQRCode } from '@/lib/qr-utils';

const QR_WIDTH = 220;

interface TorAddressDisplayProps {
  /** `<address>.onion` — the exact string the receiver must enter. */
  address: string;
  /** The one-time password, all 12 characters of it secret. */
  password: string;
}

/**
 * The sender's half of the Tor rendezvous: an onion address and a one-time
 * password, shown together because the receiver needs both and neither is
 * useful alone.
 *
 * They are deliberately not combined into one string or one QR code. The QR
 * carries the address alone — the bare `<address>.onion` the receive page and
 * ptransfer-cli's `tor receive` both take — so that the password can travel by
 * a different route if the sender wants that. It is the only thing here worth
 * guarding, and a code that carried both would hand the whole transfer to
 * anyone who caught the screen.
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

    generateTextQRCode(address, {
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

      {/* Scannable address. The password is not in it, by design. */}
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
                  alt="QR code containing the onion address"
                  className="block w-full h-auto"
                />
              ) : (
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            Scanning this fills in the address only — read them the password
            separately.
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
