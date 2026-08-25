import { KeyRound, Lock, QrCode, Shield, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  PinModeIllustration,
  QrModeIllustration,
} from '@/components/illustrations';
import { SectionContainer } from '@/components/section-container';
import { OFFLINE_QR_TRANSFER_URL } from '@/lib/constants';
import { generateTextQRCode } from '@/lib/qr-utils';

const VALUE_PROPS = [
  { icon: Lock, label: 'End-to-end encrypted' },
  { icon: Zap, label: 'Direct peer-to-peer first' },
  { icon: Shield, label: 'No sign-up' },
] as const;

// Shared by every transfer, whatever mode you use.
const COMMON_DETAILS = [
  { label: 'Content encryption:', value: 'AES-256-GCM' },
  { label: 'Primary transport:', value: 'Direct peer-to-peer over WebRTC' },
  {
    label: 'Size limits:',
    value: '2 GiB selected input; 100 MiB for the Manual relay fallback',
  },
] as const;

// Specific to PIN Exchange.
const PIN_DETAILS = [
  {
    label: 'Key exchange:',
    value: 'SPAKE2 password-authenticated key exchange over the PIN',
  },
  {
    label: 'PIN format:',
    value:
      '12 case-sensitive letters and digits: 3 public locator characters, 8 secret characters, and a checksum',
  },
  {
    label: 'PIN rotation:',
    value:
      'Fresh PIN every 2 minutes; only the current and previous time buckets work',
  },
  {
    label: 'Confirmation code:',
    value:
      'The receiver shows an 8-character code the sender must enter; nothing is sent until it matches, so a copied PIN alone cannot pull the file',
  },
  {
    label: 'Sender wait window:',
    value: '30 minutes before an unclaimed transfer gives up',
  },
  { label: 'Signaling:', value: 'Relay signaling' },
] as const;

// Specific to Code Exchange.
const QR_DETAILS = [
  { label: 'Key exchange:', value: 'ECDH' },
  {
    label: 'Signaling:',
    value:
      'Offer and answer both by QR/copy-paste; relays carry only the file fallback',
  },
] as const;

function SpecList({
  items,
}: {
  items: readonly { label: string; value: string }[];
}) {
  return (
    <dl className="mt-4 grid gap-x-6 gap-y-2 rounded-xl bg-muted/40 p-4 sm:grid-cols-2">
      {items.map(({ label, value }) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-foreground">{label}</dt>
          <dd className="text-xs text-muted-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AboutContent() {
  const siteUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const [shareQrUrl, setShareQrUrl] = useState<string | null>(null);
  const [shareQrError, setShareQrError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!siteUrl) return;
    generateTextQRCode(siteUrl, { width: 220, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (active) setShareQrUrl(url);
      })
      .catch((err) => {
        if (active)
          setShareQrError(
            err instanceof Error ? err.message : 'Failed to generate QR code',
          );
      });
    return () => {
      active = false;
    };
  }, [siteUrl]);

  return (
    <div className="flex flex-col gap-16 pb-8 sm:gap-24">
      {/* What is pTransfer */}
      <SectionContainer className="pt-2 sm:pt-6">
        <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            What is pTransfer?
          </h1>

          <div className="mt-5 space-y-4 text-pretty text-base text-muted-foreground">
            <p>
              pTransfer is a free, open-source tool for sending files and
              folders straight from one device to another with end-to-end
              encryption. Your content is encrypted in your browser and first
              tries a direct peer-to-peer connection. If that connection cannot
              be established, eligible Code Exchange files can travel as
              temporary ciphertext through public Nostr relays.
            </p>
            <p>
              There are no accounts and no tracking. Each transfer uses a fresh,
              throwaway identity, and the whole app is a static site with no
              backend, no database, and nothing to sign up for. It also installs
              as a Progressive Web App, so it keeps working offline.
            </p>
            <p>
              You hand something to the recipient either way; the two transfer
              modes differ in what you carry. A short{' '}
              <span className="font-medium text-foreground">PIN</span> lets
              relays set up the handshake for you, while a{' '}
              <span className="font-medium text-foreground">Code Exchange</span>{' '}
              carries the whole connection code (QR code or copy/paste) and can
              even work offline on the same local network.
            </p>
          </div>

          <ul className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            {VALUE_PROPS.map(({ icon: Icon, label }) => (
              <li key={label} className="inline-flex items-center gap-1.5">
                <Icon className="h-4 w-4 text-primary" />
                {label}
              </li>
            ))}
          </ul>
        </div>
      </SectionContainer>

      {/* Technical Details */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Technical details</h2>
          <p className="mt-3 text-muted-foreground">
            What's the same for every transfer, whichever mode you pick.
          </p>
        </div>
        <dl className="mt-8 grid gap-x-8 gap-y-3 rounded-2xl bg-muted/40 p-6 sm:grid-cols-3 sm:p-8">
          {COMMON_DETAILS.map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="text-sm font-medium text-foreground">{label}</dt>
              <dd className="text-sm text-muted-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </SectionContainer>

      {/* Transfer Modes */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Two ways to connect</h2>
          <p className="mt-3 text-muted-foreground">
            Every transfer is end-to-end encrypted. The modes differ in
            signaling and in whether a failed direct connection has a relay
            fallback.
          </p>
        </div>
        <div className="mt-10 grid gap-6">
          <div className="grid gap-5 rounded-2xl border bg-card p-6 shadow-sm sm:grid-cols-[200px_1fr] sm:items-start sm:gap-7">
            <PinModeIllustration className="mx-auto w-full max-w-[200px] sm:mx-0" />
            <div>
              <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <KeyRound className="h-5 w-5 text-primary" />
                PIN Exchange
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                PIN Exchange uses an end-to-end encrypted direct WebRTC
                transfer. Instead of you carrying the whole connection code, the
                app carries the handshake through third-party Nostr relays and
                authenticates it with a SPAKE2 exchange driven by the PIN you
                share. PIN Exchange has no file-relay fallback.
              </p>
              <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>
                  Best when carrying a long code is impractical — no camera, a
                  blocked clipboard, or devices that are not side by side. A
                  short PIN is all you have to move.
                </li>
                <li>
                  PIN is shared out-of-band (chat, voice, etc.), then receiver
                  enters it to find and authenticate the sender — the actual
                  decryption key comes from a password-authenticated key
                  exchange (SPAKE2) with fresh ephemeral keys on both devices,
                  so the PIN alone unlocks nothing after the fact.
                </li>
                <li>
                  Relay servers coordinate signaling only; they do not get
                  plaintext file contents or your decryption key.
                </li>
                <li>
                  File data is always transferred directly peer-to-peer over
                  WebRTC in this mode; PIN Exchange relays carry signaling, not
                  file contents.
                </li>
              </ul>
              <SpecList items={PIN_DETAILS} />
            </div>
          </div>
          <div className="grid gap-5 rounded-2xl border bg-card p-6 shadow-sm sm:grid-cols-[200px_1fr] sm:items-start sm:gap-7">
            <QrModeIllustration className="mx-auto w-full max-w-[200px] sm:mx-0" />
            <div>
              <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <QrCode className="h-5 w-5 text-primary" />
                Code Exchange
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Coordination starts by handing the recipient a signaling payload
                — by QR code or copy/paste — with no account and no coordination
                server holding it. That payload is obfuscated, not encrypted, so
                hand it only to the intended recipient. The recipient hands the
                response back the same way — by QR or copy/paste — and it only
                enters the sender's page when the sender scans or pastes it.
                STUN may help find a direct route when internet is available. If
                direct WebRTC fails, an eligible encrypted file up to 100 MiB
                can use temporary public Nostr relays instead.
              </p>
              <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>
                  Best when you prefer direct device-to-device coordination
                  using camera scan or copy/paste.
                </li>
                <li>
                  The offer is handed to the recipient directly — as a QR code
                  or by copy/paste — with no relay coordination service holding
                  it, and the response comes back the same way.
                </li>
                <li>
                  With internet, STUN can assist direct candidate discovery
                  using only connection metadata (for example IP address and
                  port), but it does not relay file traffic.
                </li>
                <li>
                  Without internet, transfer can still work over a shared local
                  network with no third-party servers.
                </li>
                <li>
                  The initial handoff adds the variables of camera quality,
                  lighting, or clipboard access.
                </li>
              </ul>
              <SpecList items={QR_DETAILS} />
            </div>
          </div>
        </div>
        <div className="mt-6 flex gap-3 rounded-2xl border border-dashed bg-muted/30 p-5 text-sm text-muted-foreground">
          <QrCode className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <p>
            Both modes try direct WebRTC first, and neither configures a TURN
            server. PIN Exchange fails if no direct route exists. Code Exchange
            can instead use its encrypted Nostr fallback for eligible files up
            to 100 MiB, but that public-relay path is best-effort too. If
            neither path completes and the devices are together, transfer the
            file offline with animated QR codes using{' '}
            <a
              href={OFFLINE_QR_TRANSFER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-2"
            >
              Secure QR Transfer
            </a>{' '}
            instead.
          </p>
        </div>
      </SectionContainer>

      {/* Share App */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Share the app</h2>
          <p className="mt-3 text-muted-foreground">
            Scan to open pTransfer on another device.
          </p>
        </div>
        <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-4 rounded-2xl border bg-muted/40 p-6">
          {shareQrUrl && !shareQrError ? (
            <div className="flex flex-col items-center gap-2">
              <img
                src={shareQrUrl}
                alt="Scan to open on mobile"
                className="h-[220px] w-[220px] rounded-md border bg-white p-2"
              />
              <p className="text-xs text-muted-foreground">
                Scan to open on mobile
              </p>
            </div>
          ) : shareQrError ? (
            <div className="text-xs text-destructive">{shareQrError}</div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Generating QR code...
            </div>
          )}
          <p className="break-all text-center text-sm text-muted-foreground">
            {siteUrl}
          </p>
        </div>
      </SectionContainer>

      {/* Source */}
      <SectionContainer>
        <p className="text-center text-xs text-muted-foreground">
          Source code available for audit at{' '}
          <a
            href="https://github.com/andrewtheguy/ptransfer"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            GitHub
          </a>
        </p>
      </SectionContainer>
    </div>
  );
}
