import {
  Download,
  FileUp,
  KeyRound,
  Lock,
  Send,
  Share2,
  Shield,
  Zap,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Hero } from '@/components/hero';
import { SectionContainer } from '@/components/section-container';
import { Button } from '@/components/ui/button';

const STEPS = [
  {
    icon: FileUp,
    title: 'Pick your files',
    description: 'Choose individual files or a whole folder, right on device.',
  },
  {
    icon: KeyRound,
    title: 'Choose a mode',
    description:
      'Auto Exchange uses automatic signaling and direct WebRTC. Manual Exchange swaps an offer by QR or copy/paste and can relay encrypted files when no direct route exists.',
  },
  {
    icon: Share2,
    title: 'Share pairing info',
    description:
      'Hand off the PIN, or exchange the connection data — by QR code or copy/paste — with your recipient.',
  },
  {
    icon: Send,
    title: 'Transfer securely',
    description:
      'Files stay end-to-end encrypted over direct WebRTC or Manual Exchange’s relay fallback.',
  },
] as const;

const FEATURES = [
  {
    icon: Lock,
    title: 'End-to-end encryption',
    description:
      'Content is encrypted with AES-256-GCM before it leaves your device. Only the paired endpoints derive the content key; the PIN itself cannot decrypt a file.',
  },
  {
    icon: Zap,
    title: 'Direct P2P first',
    description:
      'Files normally travel directly over WebRTC. If that fails, eligible Manual Exchange files can use a temporary encrypted Nostr relay path.',
  },
  {
    icon: Shield,
    title: 'No accounts required',
    description:
      'No sign-ups, no tracking. Each transfer uses a fresh ephemeral identity that is discarded after use.',
  },
] as const;

export function HomePage() {
  return (
    <div className="flex flex-col gap-16 pb-8 sm:gap-24">
      <Hero />

      {/* How it works */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">How it works</h2>
          <p className="mt-3 text-muted-foreground">
            Four quick steps from your device to theirs — no setup needed.
          </p>
        </div>
        <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, title, description }, index) => (
            <li
              key={title}
              className="relative rounded-2xl border bg-card p-6 shadow-sm transition-shadow hover:shadow-md"
            >
              <span
                aria-hidden="true"
                className="absolute right-5 top-5 text-5xl font-bold leading-none text-primary/10"
              >
                {index + 1}
              </span>
              <div className="inline-flex rounded-xl bg-primary/10 p-2.5 text-primary">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-base font-semibold">{title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {description}
              </p>
            </li>
          ))}
        </ol>
      </SectionContainer>

      {/* Features */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Built for privacy</h2>
          <p className="mt-3 text-muted-foreground">
            Security isn't an add-on here — it's how every transfer works.
          </p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="rounded-2xl border bg-card p-6 shadow-sm"
            >
              <div className="inline-flex rounded-xl bg-primary/10 p-2.5 text-primary">
                <Icon className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-6 text-center">
          <Link
            to="/about"
            className="text-sm font-medium text-primary hover:underline"
          >
            Learn how it stays secure →
          </Link>
        </div>
      </SectionContainer>

      {/* Closing CTA */}
      <SectionContainer>
        <div className="relative overflow-hidden rounded-3xl border border-primary/15 bg-gradient-to-br from-primary/10 via-background to-secondary/10 px-6 py-12 text-center sm:px-12">
          <h2 className="text-2xl sm:text-3xl">Ready to send something?</h2>
          <p className="mx-auto mt-3 max-w-md text-muted-foreground">
            Start an encrypted transfer in seconds — no account, no upload.
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
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
        </div>
      </SectionContainer>
    </div>
  );
}
