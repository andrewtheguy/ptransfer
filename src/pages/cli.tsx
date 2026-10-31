import {
  ArrowLeftRight,
  BookOpen,
  Gauge,
  Globe,
  LayoutPanelLeft,
  Package,
  Server,
  Terminal,
  Workflow,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { SectionContainer } from '@/components/section-container';
import {
  CopyCommand,
  TerminalCommand,
  TerminalComment,
  TerminalGap,
  TerminalWindow,
} from '@/components/terminal';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  BEAM_RS_URL,
  PTRANSFER_CLI_DOCS_URL,
  PTRANSFER_CLI_INSTALL_SH,
  PTRANSFER_CLI_RELEASES_URL,
} from '@/lib/constants';
import { PROTOCOL_VERSION } from '@/lib/protocol-version';

interface ModeExample {
  value: string;
  label: string;
  sender: { command: string; comment: string }[];
  receiver: { command: string; comment: string }[];
  withBrowser: React.ReactNode;
}

const MODES: ModeExample[] = [
  {
    value: 'pin',
    label: 'PIN Exchange',
    sender: [
      {
        command: 'ptransfer send --pin ./report.pdf',
        comment:
          'shows a PIN to read out, a fresh one every couple of minutes, then asks for the confirmation code the receiver shows',
      },
      {
        command: 'ptransfer send --pin --anonymous ./report.pdf',
        comment: 'the same, with the handshake carried through Tor',
      },
    ],
    receiver: [
      {
        command: 'ptransfer receive --pin',
        comment:
          'asks for the PIN, prints a confirmation code to read back, and saves the file once the sender types it',
      },
    ],
    withBrowser: (
      <>
        A PIN from this site&apos;s{' '}
        <Link
          to="/send"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Send
        </Link>{' '}
        page goes to{' '}
        <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-xs">
          ptransfer receive --pin
        </code>
        , and a PIN the terminal shows goes into the{' '}
        <Link
          to="/receive"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Receive
        </Link>{' '}
        page here.
      </>
    ),
  },
  {
    value: 'code',
    label: 'Code Exchange',
    sender: [
      {
        command: 'ptransfer send --code ./photos ./notes.txt',
        comment:
          'prints a code for the receiver, then asks for their response; several files or a folder go as one ZIP',
      },
      {
        command: 'ptransfer send --code --anonymous ./report.pdf',
        comment: 'falls back through Tor instead of public Nostr relays',
      },
    ],
    receiver: [
      {
        command: 'ptransfer receive --code --out ~/Downloads',
        comment:
          'asks for the sender’s code, prints a response to hand back, and saves into ~/Downloads',
      },
    ],
    withBrowser: (
      <>
        Codes travel as text: exactly what{' '}
        <span className="font-medium text-foreground">Copy Data</span> gives you
        on this site and what its{' '}
        <span className="font-medium text-foreground">Paste</span> tab takes. A
        terminal has no camera and draws no QR grid, so carry the code by copy
        and paste.
      </>
    ),
  },
  {
    value: 'tor',
    label: 'Tor Onion Service',
    sender: [
      {
        command: 'ptransfer send --tor ./report.pdf',
        comment:
          'publishes an onion service, prints its .onion address and a one-time password, then waits',
      },
    ],
    receiver: [
      {
        command: 'ptransfer receive --onion <address>.onion',
        comment: 'asks for the one-time password, or reads it from a pipe',
      },
    ],
    withBrowser: (
      <>
        A tab connects to an onion service the terminal published, and{' '}
        <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-xs">
          ptransfer receive --onion
        </code>{' '}
        connects to one a tab published.
      </>
    ),
  },
];

const REASONS = [
  {
    icon: LayoutPanelLeft,
    title: 'Terminal UI',
    description:
      'Run ptransfer with no command to get this app’s screens in your terminal: a file browser, the three transfer modes, and a box to paste whatever a sender gave you.',
  },
  {
    icon: Server,
    title: 'No browser needed',
    description:
      'Servers, headless machines, and machines you only reach over SSH can send and receive.',
  },
  {
    icon: Workflow,
    title: 'Scriptable',
    description:
      'Every command is line-oriented. What the other side needs goes to standard output and everything else to standard error. Codes and passwords are read from standard input, so they stay out of shell history.',
  },
  {
    icon: Gauge,
    title: 'Tor in seconds',
    description:
      'The CLI fetches the Tor directory over plain HTTP and caches it, so bootstrapping takes seconds instead of the minutes it takes in a browser tab.',
  },
] as const;

const linkClass = 'font-medium underline underline-offset-2';

export function CliPage() {
  return (
    <div className="flex flex-col gap-16 pb-8 sm:gap-24">
      {/* Hero */}
      <SectionContainer className="sm:pt-8">
        <div className="grid items-center gap-10 md:grid-cols-2">
          <div className="flex min-w-0 flex-col items-center text-center md:items-start md:text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
              <Terminal className="h-3.5 w-3.5" />
              Linux and macOS
            </span>
            <h1 className="mt-5 text-balance bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent">
              pTransfer in your terminal
            </h1>
            <p className="mt-4 max-w-md text-pretty text-base text-muted-foreground sm:text-lg">
              <span className="font-medium text-foreground">ptransfer</span> is
              this app as one self-contained executable. It runs the same
              protocol, crypto and Tor code, so either end of a transfer can be
              a browser tab or a terminal. Run{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm text-foreground">
                ptransfer
              </code>{' '}
              to open the terminal UI: pick files, then a mode, or paste what a
              sender gave you.
            </p>
            <CopyCommand
              command={PTRANSFER_CLI_INSTALL_SH}
              className="mt-6 w-full max-w-md text-left"
            />
            <p className="mt-2 max-w-md text-xs text-muted-foreground">
              Installs to{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                ~/.local/bin
              </code>{' '}
              without sudo, after checking the download against its published
              checksum.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3 md:justify-start">
              <Button asChild variant="outline" className="gap-2">
                <a
                  href={PTRANSFER_CLI_DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <BookOpen className="h-4 w-4" />
                  Documentation
                </a>
              </Button>
              <Button asChild variant="outline" className="gap-2">
                <a
                  href={PTRANSFER_CLI_RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Package className="h-4 w-4" />
                  Releases
                </a>
              </Button>
            </div>
          </div>

          <TerminalWindow title="~" className="min-w-0">
            <TerminalCommand>ptransfer</TerminalCommand>
            <TerminalComment>
              opens the terminal UI: pick files and folders, choose PIN, Code or
              Tor, or paste what a sender gave you
            </TerminalComment>
            <TerminalGap />
            <TerminalComment>or, from a script:</TerminalComment>
            <TerminalCommand>ptransfer send --pin ./report.pdf</TerminalCommand>
            <TerminalCommand>ptransfer receive --pin</TerminalCommand>
          </TerminalWindow>
        </div>
      </SectionContainer>

      {/* Interop */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Every mode, both ways</h2>
          <p className="mt-3 text-muted-foreground">
            A PIN, a code or an onion address from the terminal works on this
            site as it is, and the other way round. Two peers work together
            whenever their protocol versions match. This site speaks protocol{' '}
            {PROTOCOL_VERSION}, and{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">
              ptransfer --version
            </code>{' '}
            prints the CLI&apos;s. The terminal UI offers every mode from a
            menu; these are the same transfers as commands, for scripts.
          </p>
        </div>

        <div className="mx-auto mt-8 flex max-w-xl items-center justify-center gap-4 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border bg-card px-3 py-2 shadow-sm sm:px-4">
            <Globe className="h-4 w-4 text-primary" />
            Browser tab
          </span>
          <ArrowLeftRight className="h-5 w-5 shrink-0 text-primary" />
          <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border bg-card px-3 py-2 shadow-sm sm:px-4">
            <Terminal className="h-4 w-4 text-primary" />
            Terminal
          </span>
        </div>

        <Tabs defaultValue="pin" className="mx-auto mt-8 max-w-4xl">
          <TabsList className="grid h-auto w-full grid-cols-3">
            {MODES.map(({ value, label }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="whitespace-normal px-1 text-xs sm:text-sm"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {MODES.map(({ value, sender, receiver, withBrowser }) => (
            <TabsContent key={value} value={value} className="mt-4">
              <div className="grid gap-4 md:grid-cols-2">
                <TerminalWindow title="sender" className="min-w-0">
                  {sender.map(({ command, comment }, index) => (
                    <div key={command}>
                      {index > 0 && <TerminalGap />}
                      <TerminalCommand>{command}</TerminalCommand>
                      <TerminalComment>{comment}</TerminalComment>
                    </div>
                  ))}
                </TerminalWindow>
                <TerminalWindow title="receiver" className="min-w-0">
                  {receiver.map(({ command, comment }, index) => (
                    <div key={command}>
                      {index > 0 && <TerminalGap />}
                      <TerminalCommand>{command}</TerminalCommand>
                      <TerminalComment>{comment}</TerminalComment>
                    </div>
                  ))}
                </TerminalWindow>
              </div>
              <div className="mt-4 flex gap-3 rounded-2xl border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                <Globe className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <p>{withBrowser}</p>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </SectionContainer>

      {/* Why */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Why use the terminal</h2>
          <p className="mt-3 text-muted-foreground">
            It is the same transfer, with what a process has and a page does
            not.
          </p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          {REASONS.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="rounded-2xl border bg-card p-6 shadow-sm"
            >
              <div className="inline-flex rounded-xl bg-primary/10 p-2.5 text-primary">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-base font-semibold">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </div>
      </SectionContainer>

      {/* Install details */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">Install</h2>
          <p className="mt-3 text-muted-foreground">
            One executable for Linux x64, Linux arm64 and Apple silicon macOS,
            with no runtime or package manager to install.
          </p>
        </div>
        <div className="mx-auto mt-8 max-w-2xl space-y-6 rounded-2xl border bg-card p-6 shadow-sm">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Latest release
            </p>
            <CopyCommand command={PTRANSFER_CLI_INSTALL_SH} />
            <p className="text-xs text-muted-foreground">
              The installer picks the executable for your machine, checks it
              against its published checksum, and puts it in{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                ~/.local/bin
              </code>{' '}
              without sudo. It warns you when another{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                ptransfer
              </code>{' '}
              earlier on your{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                PATH
              </code>{' '}
              would run instead.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Newest prerelease
            </p>
            <CopyCommand
              command={`${PTRANSFER_CLI_INSTALL_SH} -s -- --prerelease`}
            />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Download only, into the current directory
            </p>
            <CopyCommand
              command={`${PTRANSFER_CLI_INSTALL_SH} -s -- --download-only`}
            />
            <p className="text-xs text-muted-foreground">
              Or download{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                ptransfer-linux-amd64
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                ptransfer-linux-arm64
              </code>{' '}
              or{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                ptransfer-macos-arm64
              </code>{' '}
              yourself from{' '}
              <a
                href={PTRANSFER_CLI_RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                Releases
              </a>{' '}
              and{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                chmod +x
              </code>{' '}
              it. A release tag after{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                -s --
              </code>{' '}
              installs that release instead of the latest.
            </p>
          </div>
          <div className="border-t pt-4 text-xs text-muted-foreground">
            There is no Windows build: use WSL, or this site. For a command line
            on Windows, or for files larger than 2 GiB, use{' '}
            <a
              href={BEAM_RS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              beam-rs
            </a>
            . Every command, flag and option is documented in{' '}
            <a
              href={PTRANSFER_CLI_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              the README
            </a>
            .
          </div>
        </div>
      </SectionContainer>
    </div>
  );
}
