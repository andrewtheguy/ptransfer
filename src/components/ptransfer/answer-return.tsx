import { QRDisplay } from './qr-display';

export interface AnswerReturnProps {
  answerData: Uint8Array;
  clipboardData?: string;
}

/**
 * The receiver's half of the answer step: the QR / copy-paste instructions.
 * The answer only ever reaches the sender through their own scan or paste.
 */
export function AnswerReturn({ answerData, clipboardData }: AnswerReturnProps) {
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
