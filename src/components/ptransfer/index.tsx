import { Download } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ReceiveTab } from './receive-tab';
import { SendTab } from './send-tab';

type PTransferView = 'send' | 'receive';

type PTransferProps = {
  view?: PTransferView;
};

export function PTransfer({ view = 'send' }: PTransferProps) {
  const getTitle = () => {
    switch (view) {
      case 'send':
        return 'Secure Send';
      case 'receive':
        return 'Secure Receive';
      default:
        return 'Secure Send';
    }
  };

  const getCardClassName = () => {
    switch (view) {
      case 'receive':
        return 'w-full max-w-2xl border-cyan-200 dark:border-cyan-900/50 bg-gradient-to-br from-background to-cyan-50/30 dark:to-cyan-950/10';
      default:
        return 'w-full max-w-2xl';
    }
  };

  const getTitleClassName = () => {
    switch (view) {
      case 'send':
        return 'text-2xl text-primary';
      case 'receive':
        return 'text-2xl text-cyan-700 dark:text-cyan-500';
      default:
        return 'text-2xl';
    }
  };

  return (
    <Card className={getCardClassName()}>
      <CardHeader>
        <CardTitle className={getTitleClassName()}>{getTitle()}</CardTitle>
        <CardDescription>
          {view === 'send' && (
            <span className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
              <span>
                Share files or folders securely with end-to-end encryption.
              </span>
              <Link
                to="/receive"
                className="inline-flex items-center gap-1 text-primary hover:underline whitespace-nowrap"
              >
                <Download className="h-3 w-3" />
                <span>Receive files instead</span>
              </Link>
            </span>
          )}
          {view === 'receive' &&
            'Receive files or folders securely with end-to-end encryption.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {view === 'send' && <SendTab />}
        {view === 'receive' && <ReceiveTab />}
      </CardContent>
    </Card>
  );
}
