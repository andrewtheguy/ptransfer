import { QrCode, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AnswerReturnMethod } from '@/hooks/use-manual-receive';

export interface AnswerReturnChoiceProps {
  onChoose: (method: AnswerReturnMethod) => void;
}

/**
 * The receiver's explicit decision on how the answer gets back to the sender
 * when the sender's code named relays. Nothing is published until they pick.
 */
export function AnswerReturnChoice({ onChoose }: AnswerReturnChoiceProps) {
  return (
    <div className="space-y-3 rounded-lg bg-muted/50 border p-4">
      <p className="font-medium">How should your response reach the sender?</p>
      <p className="text-sm text-muted-foreground">
        The sender's code names Nostr relays that can carry your response back
        to their page. You can use them, or hand the response back yourself as a
        code for the sender to scan or paste.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button onClick={() => onChoose('relay')} className="h-auto py-3">
          <Radio className="h-4 w-4 mr-2 shrink-0" />
          <span className="text-left">
            <span className="block">Send through relays</span>
            <span className="block text-xs font-normal opacity-80">
              Nothing to carry back; the sender's page must stay open
            </span>
          </span>
        </Button>
        <Button
          variant="outline"
          onClick={() => onChoose('manual')}
          className="h-auto py-3"
        >
          <QrCode className="h-4 w-4 mr-2 shrink-0" />
          <span className="text-left">
            <span className="block">Show a code to scan or paste</span>
            <span className="block text-xs font-normal opacity-80">
              The sender takes it in under "Scan or paste the response"
            </span>
          </span>
        </Button>
      </div>
    </div>
  );
}
