import { Check, Copy, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface ConfirmationCodeDisplayProps {
  code: string;
}

/**
 * The receiver's half of the anti-front-running check.
 *
 * Shown the moment the PIN opens the sender's rendezvous payload, well before
 * anything transfers. The sender cannot proceed until someone reads this code
 * across to them, which is what makes it useless to an attacker who learned the
 * PIN by watching the sender's screen: they can claim the transfer, but the
 * code their browser derived is not the one the sender is about to be told.
 */
export function ConfirmationCodeDisplay({
  code,
}: ConfirmationCodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy confirmation code:', err);
    }
  };

  // Split for legibility only — the sender's input accepts it either way.
  const grouped = `${code.slice(0, 4)}-${code.slice(4)}`;

  return (
    <div className="rounded-lg border bg-muted/40 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4" />
        Confirmation code
      </div>

      <div className="font-mono text-3xl text-center tracking-[0.15em] select-all break-all">
        {grouped}
      </div>

      <p className="text-xs text-muted-foreground">
        Read this code to the sender. The transfer only starts once they enter
        it, so nothing is sent to anyone who guessed or copied the PIN.
      </p>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className="self-start"
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5" /> Copied
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" /> Copy code
          </>
        )}
      </Button>
    </div>
  );
}
