import { Download, Lock, Send, Shield, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PTransferIllustration } from '@/components/illustrations';
import { SectionContainer } from '@/components/section-container';
import { Button } from '@/components/ui/button';

const VALUE_PROPS = [
  { icon: Lock, label: 'End-to-end encrypted' },
  { icon: Zap, label: 'Direct peer-to-peer first' },
  { icon: Shield, label: 'No sign-up' },
] as const;

export function Hero() {
  return (
    <SectionContainer className="sm:pt-12 sm:pb-4">
      <div className="grid items-center gap-3 md:grid-cols-2 md:gap-8">
        <div className="flex flex-col items-center text-center md:items-start md:text-left">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
            <Lock className="h-3.5 w-3.5" />
            Private by design
          </span>

          <h1 className="mt-3 text-balance bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent sm:mt-5">
            Send files. Stay private.
          </h1>

          <p className="mt-3 max-w-md text-pretty text-base text-muted-foreground sm:mt-4 sm:text-lg">
            Share files and folders straight from your device with end-to-end
            encryption. No accounts or central file server: transfers try a
            direct connection first, with an encrypted relay fallback in Manual
            Exchange when needed.
          </p>

          <div className="mt-3 flex w-full flex-col gap-3 sm:mt-6 sm:w-auto sm:flex-row">
            <Button asChild size="lg" className="gap-2">
              <Link to="/send">
                <Send className="h-4 w-4" />
                Send files
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="gap-2">
              <Link to="/receive">
                <Download className="h-4 w-4" />
                Receive files
              </Link>
            </Button>
          </div>

          <ul className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground md:justify-start">
            {VALUE_PROPS.map(({ icon: Icon, label }) => (
              <li key={label} className="inline-flex items-center gap-1.5">
                <Icon className="h-4 w-4 text-primary" />
                {label}
              </li>
            ))}
          </ul>
        </div>

        <div className="order-first md:order-last">
          <PTransferIllustration className="mx-auto w-full max-w-md" />
        </div>
      </div>
    </SectionContainer>
  );
}
