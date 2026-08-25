import { QRDisplay } from './qr-display';

export interface AnswerReturnProps {
  answerData: Uint8Array;
  clipboardData?: string;
  /**
   * True when the answer went back over the relays the receiver chose: the
   * sender already has it and there is no code to show — once it lands the
   * sender's page moves on and stops accepting a scanned or pasted one.
   * False is the hand-carried exchange (chosen, or the only option when the
   * offer named no relays). The two never fall back to each other.
   */
  answerRelayed: boolean;
}

/**
 * The receiver's half of the answer step: either "already sent, nothing to
 * do", or the QR / copy-paste instructions.
 */
export function AnswerReturn({
  answerData,
  clipboardData,
  answerRelayed,
}: AnswerReturnProps) {
  if (answerRelayed) {
    return (
      <div className="space-y-3 rounded-lg bg-muted/50 border p-4">
        <p className="font-medium">Response sent to the sender</p>
        <p className="text-sm text-muted-foreground">
          It went back over the relays named in the sender's code, so there is
          nothing to scan or copy. Keep this page open — the transfer connects
          on its own once the sender has it. If the sender's page reports a
          failed connection, both sides need to start over.
        </p>
      </div>
    );
  }

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
            sender opens <strong>Scan or paste the receiver's response</strong>{' '}
            on their page and scans the code below with the in-app scanner.
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
