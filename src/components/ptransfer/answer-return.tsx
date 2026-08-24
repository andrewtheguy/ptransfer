import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { QRDisplay } from './qr-display';

// A response that went out over relays hides its code, but not forever: if
// the sender has not connected by now, something on that path failed
// silently and the hand-carried hop is the way out.
const ANSWER_CODE_REVEAL_MS = 30 * 1000;

export interface AnswerReturnProps {
  answerData: Uint8Array;
  clipboardData?: string;
  /**
   * Outcome of the relay answer channel the offer named: 'sent' collapses the
   * code behind a disclosure, 'failed' explains why it still has to be
   * carried back, and undefined is the plain two-hop exchange.
   */
  answerRelayStatus?: 'sent' | 'failed';
}

/**
 * The receiver's half of the answer step: either "already sent, nothing to
 * do" with the code one tap away, or the QR / copy-paste instructions.
 */
export function AnswerReturn({
  answerData,
  clipboardData,
  answerRelayStatus,
}: AnswerReturnProps) {
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (answerRelayStatus !== 'sent') return;
    const timer = setTimeout(() => setShowCode(true), ANSWER_CODE_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [answerRelayStatus]);

  if (answerRelayStatus === 'sent' && !showCode) {
    return (
      <div className="space-y-3 rounded-lg bg-muted/50 border p-4">
        <p className="font-medium">Response sent to the sender</p>
        <p className="text-sm text-muted-foreground">
          It went back over the relays named in the sender's code, so there is
          nothing to scan or copy. Keep this page open — the transfer connects
          on its own once the sender has it.
        </p>
        <Button variant="outline" size="sm" onClick={() => setShowCode(true)}>
          Show response code instead
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-muted/50 border p-4 space-y-2">
        <p className="font-medium">Send your response back to the sender</p>
        {answerRelayStatus === 'failed' && (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            The relays named in the sender's code did not take your response, so
            it has to go back by hand this time.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Get your response back to the sender by the QR code below or
          copy/paste the data:
        </p>
        <ul className="text-sm text-muted-foreground space-y-2">
          <li>
            <span className="font-medium text-foreground">QR code:</span> the
            sender scans the code below with their camera.
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
          Keep this page open — the transfer connects automatically once the
          sender has your response.
        </p>
      </div>
      <QRDisplay
        data={answerData}
        clipboardData={clipboardData}
        label="Your response"
      />
    </div>
  );
}
