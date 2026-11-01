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
import { SectionContainer } from '@/components/section-container';
import {
  CopyCommand,
  TerminalCommand,
  TerminalComment,
  TerminalGap,
  TerminalWindow,
  TUI_COLORS,
  TuiScreen,
} from '@/components/terminal';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT } from '@/i18n/locale-context';
import { LocaleLink } from '@/i18n/locale-link';
import {
  BEAM_RS_URL,
  PTRANSFER_CLI_DOCS_URL,
  PTRANSFER_CLI_INSTALL_PS1,
  PTRANSFER_CLI_INSTALL_SH,
  PTRANSFER_CLI_RELEASES_URL,
} from '@/lib/constants';
import type { Localized } from '@/lib/i18n';
import { PROTOCOL_VERSION } from '@/lib/protocol-version';
import { cn } from '@/lib/utils';

type ModeValue = 'pin' | 'code' | 'tor';

interface CommandExample {
  command: string;
  comment: Localized;
}

interface ModeExample {
  value: ModeValue;
  label: Localized;
  /** What the receiver pastes into the terminal UI's Receive screen. */
  pasted: Localized;
  sender: CommandExample[];
  receiver: CommandExample[];
  withBrowser: Localized<React.ReactNode>;
}

const inlineLinkClass =
  'font-medium text-foreground underline underline-offset-2';
const inlineCodeClass =
  'whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-xs';

const MODES: ModeExample[] = [
  {
    value: 'pin',
    label: { en: 'PIN Exchange', es: 'Intercambio por PIN' },
    pasted: { en: 'the PIN', es: 'el PIN' },
    sender: [
      {
        command: 'ptransfer send --pin ./report.pdf',
        comment: {
          en: 'shows a PIN to read out, a fresh one every couple of minutes, then asks for the confirmation code the receiver shows',
          es: 'muestra un PIN para dictarlo, uno nuevo cada par de minutos, y luego pide el código de confirmación que muestra el receptor',
        },
      },
      {
        command: 'ptransfer send --pin --anonymous ./report.pdf',
        comment: {
          en: 'the same, with the handshake carried through Tor',
          es: 'lo mismo, con la negociación a través de Tor',
        },
      },
    ],
    receiver: [
      {
        command: 'ptransfer receive --pin',
        comment: {
          en: 'asks for the PIN, prints a confirmation code to read back, and saves the file once the sender types it',
          es: 'pide el PIN, muestra un código de confirmación para dictárselo al emisor y guarda el archivo en cuanto el emisor lo escribe',
        },
      },
    ],
    withBrowser: {
      en: (
        <>
          A PIN from this site&apos;s{' '}
          <LocaleLink to="/send" className={inlineLinkClass}>
            Send
          </LocaleLink>{' '}
          page goes to{' '}
          <code className={inlineCodeClass}>ptransfer receive --pin</code>, and
          a PIN the terminal shows goes into the{' '}
          <LocaleLink to="/receive" className={inlineLinkClass}>
            Receive
          </LocaleLink>{' '}
          page here.
        </>
      ),
      es: (
        <>
          Un PIN de la página{' '}
          <LocaleLink to="/send" className={inlineLinkClass}>
            Enviar
          </LocaleLink>{' '}
          de este sitio se usa con{' '}
          <code className={inlineCodeClass}>ptransfer receive --pin</code>, y un
          PIN que muestra la terminal se introduce en la página{' '}
          <LocaleLink to="/receive" className={inlineLinkClass}>
            Recibir
          </LocaleLink>{' '}
          de aquí.
        </>
      ),
    },
  },
  {
    value: 'code',
    label: { en: 'Code Exchange', es: 'Intercambio por código' },
    pasted: { en: 'the sender’s code', es: 'el código del emisor' },
    sender: [
      {
        command: 'ptransfer send --code ./photos ./notes.txt',
        comment: {
          en: 'prints a code for the receiver, then asks for their response; several files or a folder go as one ZIP',
          es: 'muestra un código para el receptor y luego pide su respuesta; varios archivos o una carpeta se envían como un solo ZIP',
        },
      },
      {
        command: 'ptransfer send --code --anonymous ./report.pdf',
        comment: {
          en: 'falls back through Tor instead of public Nostr relays',
          es: 'usa Tor como respaldo en lugar de los relays públicos de Nostr',
        },
      },
    ],
    receiver: [
      {
        command: 'ptransfer receive --code --out ~/Downloads',
        comment: {
          en: 'asks for the sender’s code, prints a response to hand back, and saves into ~/Downloads',
          es: 'pide el código del emisor, muestra una respuesta para devolvérsela y guarda en ~/Downloads',
        },
      },
    ],
    withBrowser: {
      en: (
        <>
          Codes travel as text: exactly what{' '}
          <span className="font-medium text-foreground">Copy Data</span> gives
          you on this site and what its{' '}
          <span className="font-medium text-foreground">Paste</span> tab takes.
          A terminal has no camera and draws no QR grid, so carry the code by
          copy and paste.
        </>
      ),
      es: (
        <>
          Los códigos viajan como texto: exactamente lo que te da{' '}
          <span className="font-medium text-foreground">Copiar datos</span> en
          este sitio y lo que acepta su pestaña{' '}
          <span className="font-medium text-foreground">Pegar</span>. Una
          terminal no tiene cámara ni dibuja códigos QR, así que pasa el código
          copiando y pegando.
        </>
      ),
    },
  },
  {
    value: 'tor',
    label: { en: 'Tor Onion Service', es: 'Servicio onion de Tor' },
    pasted: { en: 'the .onion address', es: 'la dirección .onion' },
    sender: [
      {
        command: 'ptransfer send --tor ./report.pdf',
        comment: {
          en: 'publishes an onion service, prints its .onion address and a one-time password, then waits',
          es: 'publica un servicio onion, muestra su dirección .onion y una contraseña de un solo uso, y espera',
        },
      },
    ],
    receiver: [
      {
        command: 'ptransfer receive --onion <address>.onion',
        comment: {
          en: 'asks for the one-time password, or reads it from a pipe',
          es: 'pide la contraseña de un solo uso, o la lee de una tubería',
        },
      },
    ],
    withBrowser: {
      en: (
        <>
          A tab connects to an onion service the terminal published, and{' '}
          <code className={inlineCodeClass}>ptransfer receive --onion</code>{' '}
          connects to one a tab published.
        </>
      ),
      es: (
        <>
          Una pestaña se conecta a un servicio onion publicado desde la
          terminal, y{' '}
          <code className={inlineCodeClass}>ptransfer receive --onion</code> se
          conecta a uno publicado desde una pestaña.
        </>
      ),
    },
  },
];

const TUI_SEND_OPTIONS: {
  value: ModeValue;
  name: Localized;
  description: Localized;
}[] = [
  {
    value: 'pin',
    name: { en: 'PIN Exchange', es: 'Intercambio por PIN' },
    description: {
      en: 'Read out a short PIN, then compare a confirmation code',
      es: 'Dicta un PIN corto y luego compara un código de confirmación',
    },
  },
  {
    value: 'code',
    name: { en: 'Code Exchange', es: 'Intercambio por código' },
    description: {
      en: 'Carry a code, then a direct connection or a relay fallback',
      es: 'Pasa un código y luego conexión directa o respaldo por relays',
    },
  },
  {
    value: 'tor',
    name: { en: 'Tor Onion Service', es: 'Servicio onion de Tor' },
    description: {
      en: 'Publish an onion service and carry its address and password',
      es: 'Publica un servicio onion y pasa su dirección y contraseña',
    },
  },
];

const TUI_ANONYMOUS_LABEL: Record<ModeValue, Localized | null> = {
  pin: {
    en: 'Anonymous signaling (experimental)',
    es: 'Señalización anónima (experimental)',
  },
  code: {
    en: 'Anonymous signaling and relay (experimental)',
    es: 'Señalización y relay anónimos (experimental)',
  },
  tor: null,
};

/** The terminal UI's Send screen with `mode` highlighted. */
function TuiSendMock({ mode }: { mode: ModeValue }) {
  const t = useT();
  const anonymous = TUI_ANONYMOUS_LABEL[mode];
  return (
    <TuiScreen
      title={t({ en: 'Send', es: 'Enviar' })}
      hints={[
        t({ en: '↑↓ choose', es: '↑↓ elegir' }),
        t({ en: 'enter start', es: 'enter iniciar' }),
        t({ en: 'esc back', es: 'esc atrás' }),
      ]}
      className="min-w-0"
    >
      <div className={TUI_COLORS.good}>
        {t({ en: 'report.pdf · 1.2 MiB', es: 'report.pdf · 1,2 MiB' })}
      </div>
      <TerminalGap />
      {TUI_SEND_OPTIONS.map((option) => {
        const selected = option.value === mode;
        return (
          <div
            key={option.value}
            className={cn('px-1', selected && 'rounded-sm bg-[#7aa2f7]/20')}
          >
            <div className={selected ? TUI_COLORS.accent : TUI_COLORS.heading}>
              {selected ? '› ' : '  '}
              {t(option.name)}
            </div>
            <div className={cn('pl-4', TUI_COLORS.muted)}>
              {t(option.description)}
            </div>
          </div>
        );
      })}
      <TerminalGap />
      <div className={TUI_COLORS.heading}>
        {anonymous
          ? t({
              en: `[ ] ${anonymous.en}   a to turn on`,
              es: `[ ] ${anonymous.es}   a para activar`,
            })
          : t({
              en: 'Tor bridge: Snowflake WebSocket   b to change',
              es: 'Puente de Tor: Snowflake WebSocket   b para cambiar',
            })}
      </div>
    </TuiScreen>
  );
}

/** The terminal UI's Receive screen, the same for every mode. */
function TuiReceiveMock({ pasted }: { pasted: string }) {
  const t = useT();
  return (
    <TuiScreen
      title={t({ en: 'Receive', es: 'Recibir' })}
      hints={[
        t({ en: 'enter continue', es: 'enter continuar' }),
        t({ en: 'esc back', es: 'esc atrás' }),
      ]}
      className="min-w-0"
    >
      <div className={TUI_COLORS.heading}>
        {t({
          en: 'Paste what the sender gave you',
          es: 'Pega lo que te dio el emisor',
        })}
      </div>
      <div className={TUI_COLORS.muted}>
        {t({
          en: 'A PIN, a Code Exchange code, or a .onion address.',
          es: 'Un PIN, un código de Intercambio por código o una dirección .onion.',
        })}
      </div>
      <div className={TUI_COLORS.muted}>
        {t({
          en: 'Where it is saved is the next screen.',
          es: 'Dónde se guarda se elige en la siguiente pantalla.',
        })}
      </div>
      <TerminalGap />
      <div
        className={cn(
          'relative rounded-sm border px-2 py-1.5',
          TUI_COLORS.border,
        )}
      >
        <span
          className={cn(
            'absolute -top-2.5 left-2 bg-zinc-950 px-1',
            TUI_COLORS.heading,
          )}
        >
          {t({ en: 'code', es: 'código' })}
        </span>
        <span className={cn('italic', TUI_COLORS.muted)}>‹{pasted}›</span>
      </div>
    </TuiScreen>
  );
}

const REASONS = [
  {
    icon: LayoutPanelLeft,
    title: { en: 'Terminal UI', es: 'Interfaz de terminal' },
    description: {
      en: 'Run ptransfer with no command to get this app’s screens in your terminal: a file browser, the three transfer modes, and a box to paste whatever a sender gave you.',
      es: 'Ejecuta ptransfer sin ningún comando y tendrás las pantallas de esta aplicación en tu terminal: un explorador de archivos, los tres modos de transferencia y un cuadro para pegar lo que te haya dado el emisor.',
    },
  },
  {
    icon: Server,
    title: { en: 'No browser needed', es: 'Sin navegador' },
    description: {
      en: 'Servers, headless machines, and machines you only reach over SSH can send and receive.',
      es: 'Los servidores, las máquinas sin pantalla y las que solo alcanzas por SSH también pueden enviar y recibir.',
    },
  },
  {
    icon: Workflow,
    title: { en: 'Scriptable', es: 'Automatizable' },
    description: {
      en: 'Every command is line-oriented. What the other side needs goes to standard output and everything else to standard error. Codes and passwords are read from standard input, so they stay out of shell history.',
      es: 'Cada comando trabaja línea a línea. Lo que necesita el otro extremo va a la salida estándar y todo lo demás a la salida de error. Los códigos y las contraseñas se leen de la entrada estándar, así que no quedan en el historial de la shell.',
    },
  },
  {
    icon: Gauge,
    title: { en: 'Tor in seconds', es: 'Tor en segundos' },
    description: {
      en: 'The CLI fetches the Tor directory over plain HTTP and caches it, so bootstrapping takes seconds instead of the minutes it takes in a browser tab.',
      es: 'La CLI descarga el directorio de Tor por HTTP simple y lo guarda en caché, así que conectar con la red Tor lleva segundos en vez de los minutos que tarda en una pestaña del navegador.',
    },
  },
] as const;

const linkClass = 'font-medium underline underline-offset-2';

export function CliPage() {
  const t = useT();
  return (
    <div className="flex flex-col gap-16 pb-8 sm:gap-24">
      {/* Hero */}
      <SectionContainer className="sm:pt-8">
        <div className="grid items-center gap-10 md:grid-cols-2">
          <div className="flex min-w-0 flex-col items-center text-center md:items-start md:text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
              <Terminal className="h-3.5 w-3.5" />
              {t({
                en: 'Linux, macOS and Windows',
                es: 'Linux, macOS y Windows',
              })}
            </span>
            <h1 className="mt-5 text-balance bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent">
              {t({
                en: 'pTransfer in your terminal',
                es: 'pTransfer en tu terminal',
              })}
            </h1>
            <p className="mt-4 max-w-md text-pretty text-base text-muted-foreground sm:text-lg">
              {t({
                en: (
                  <>
                    <span className="font-medium text-foreground">
                      ptransfer
                    </span>{' '}
                    is this app as one self-contained executable. It runs the
                    same protocol, crypto and Tor code, so either end of a
                    transfer can be a browser tab or a terminal. Run{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm text-foreground">
                      ptransfer
                    </code>{' '}
                    to open the terminal UI: pick files, then a mode, or paste
                    what a sender gave you.
                  </>
                ),
                es: (
                  <>
                    <span className="font-medium text-foreground">
                      ptransfer
                    </span>{' '}
                    es esta misma aplicación en un único ejecutable autónomo.
                    Usa el mismo código de protocolo, cifrado y Tor, así que
                    cualquiera de los dos extremos puede ser una pestaña del
                    navegador o una terminal. Ejecuta{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm text-foreground">
                      ptransfer
                    </code>{' '}
                    para abrir la interfaz de terminal: elige archivos y luego
                    un modo, o pega lo que te dio el emisor.
                  </>
                ),
              })}
            </p>
            <div className="mt-6 w-full max-w-md space-y-2 text-left">
              <p className="text-xs font-medium text-muted-foreground">
                {t({ en: 'Linux and macOS', es: 'Linux y macOS' })}
              </p>
              <CopyCommand command={PTRANSFER_CLI_INSTALL_SH} />
              <p className="pt-1 text-xs font-medium text-muted-foreground">
                {t({
                  en: 'Windows, in PowerShell',
                  es: 'Windows, en PowerShell',
                })}
              </p>
              <CopyCommand command={PTRANSFER_CLI_INSTALL_PS1} prompt="PS>" />
            </div>
            <p className="mt-2 max-w-md text-xs text-muted-foreground">
              {t({
                en: 'Both check the download against its published checksum and install without sudo or administrator rights. More options are under Install below.',
                es: 'Ambos comprueban la descarga con su suma de verificación publicada e instalan sin sudo ni permisos de administrador. Encontrarás más opciones en Instalación, más abajo.',
              })}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3 md:justify-start">
              <Button asChild variant="outline" className="gap-2">
                <a
                  href={PTRANSFER_CLI_DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <BookOpen className="h-4 w-4" />
                  {t({ en: 'Documentation', es: 'Documentación' })}
                </a>
              </Button>
              <Button asChild variant="outline" className="gap-2">
                <a
                  href={PTRANSFER_CLI_RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Package className="h-4 w-4" />
                  {t({ en: 'Releases', es: 'Versiones' })}
                </a>
              </Button>
            </div>
          </div>

          <TerminalWindow title="~" className="min-w-0">
            <TerminalCommand>ptransfer</TerminalCommand>
            <TerminalComment>
              {t({
                en: 'opens the terminal UI: pick files and folders, choose PIN, Code or Tor, or paste what a sender gave you',
                es: 'abre la interfaz de terminal: elige archivos y carpetas, escoge PIN, código o Tor, o pega lo que te dio el emisor',
              })}
            </TerminalComment>
            <TerminalGap />
            <TerminalComment>
              {t({ en: 'or, from a script:', es: 'o, desde un script:' })}
            </TerminalComment>
            <TerminalCommand>ptransfer send --pin ./report.pdf</TerminalCommand>
            <TerminalCommand>ptransfer receive --pin</TerminalCommand>
          </TerminalWindow>
        </div>
      </SectionContainer>

      {/* Interop */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">
            {t({
              en: 'Every mode, both ways',
              es: 'Todos los modos, en ambos sentidos',
            })}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t({
              en: (
                <>
                  A PIN, a code or an onion address from the terminal works on
                  this site as it is, and the other way round. Two peers work
                  together whenever their protocol versions match. This site
                  speaks protocol {PROTOCOL_VERSION}, and{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">
                    ptransfer --version
                  </code>{' '}
                  prints the CLI&apos;s. The terminal UI is the easy way in, and
                  every mode is a command too, for scripts.
                </>
              ),
              es: (
                <>
                  Un PIN, un código o una dirección onion de la terminal
                  funciona tal cual en este sitio, y al revés. Dos extremos se
                  entienden siempre que coincidan sus versiones del protocolo.
                  Este sitio usa la versión {PROTOCOL_VERSION} del protocolo, y{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">
                    ptransfer --version
                  </code>{' '}
                  muestra la de la CLI. La interfaz de terminal es la forma más
                  fácil de empezar, y cada modo es también un comando, para
                  scripts.
                </>
              ),
            })}
          </p>
        </div>

        <div className="mx-auto mt-8 flex max-w-xl items-center justify-center gap-4 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border bg-card px-3 py-2 shadow-sm sm:px-4">
            <Globe className="h-4 w-4 text-primary" />
            {t({ en: 'Browser tab', es: 'Pestaña del navegador' })}
          </span>
          <ArrowLeftRight className="h-5 w-5 shrink-0 text-primary" />
          <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border bg-card px-3 py-2 shadow-sm sm:px-4">
            <Terminal className="h-4 w-4 text-primary" />
            {t({ en: 'Terminal', es: 'Terminal' })}
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
                {t(label)}
              </TabsTrigger>
            ))}
          </TabsList>
          {MODES.map(
            ({ value, label, pasted, sender, receiver, withBrowser }) => (
              <TabsContent key={value} value={value} className="mt-4">
                <h3 className="flex items-center gap-2 text-base font-semibold">
                  <LayoutPanelLeft className="h-4 w-4 text-primary" />
                  {t({
                    en: 'In the terminal UI',
                    es: 'En la interfaz de terminal',
                  })}
                </h3>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <div className="min-w-0 space-y-2">
                    <TuiSendMock mode={value} />
                    <p className="text-sm text-muted-foreground">
                      {t({
                        en: (
                          <>
                            <span className="font-medium text-foreground">
                              Sender:
                            </span>{' '}
                            run{' '}
                            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                              ptransfer
                            </code>
                            , choose Send, mark the files and folders to send,
                            then pick {label.en}.
                          </>
                        ),
                        es: (
                          <>
                            <span className="font-medium text-foreground">
                              Emisor:
                            </span>{' '}
                            ejecuta{' '}
                            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                              ptransfer
                            </code>
                            , elige Enviar, marca los archivos y carpetas que
                            quieres enviar y luego escoge {label.es}.
                          </>
                        ),
                      })}
                    </p>
                  </div>
                  <div className="min-w-0 space-y-2">
                    <TuiReceiveMock pasted={t(pasted)} />
                    <p className="text-sm text-muted-foreground">
                      {t({
                        en: (
                          <>
                            <span className="font-medium text-foreground">
                              Receiver:
                            </span>{' '}
                            run{' '}
                            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                              ptransfer
                            </code>
                            , choose Receive, and paste {pasted.en}. It works
                            out the mode itself, then asks where to save.
                          </>
                        ),
                        es: (
                          <>
                            <span className="font-medium text-foreground">
                              Receptor:
                            </span>{' '}
                            ejecuta{' '}
                            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                              ptransfer
                            </code>
                            , elige Recibir y pega {pasted.es}. Detecta el modo
                            por sí solo y luego pregunta dónde guardar.
                          </>
                        ),
                      })}
                    </p>
                  </div>
                </div>
                <h3 className="mt-8 flex items-center gap-2 text-base font-semibold">
                  <Workflow className="h-4 w-4 text-primary" />
                  {t({
                    en: 'As commands, for scripts',
                    es: 'Como comandos, para scripts',
                  })}
                </h3>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <TerminalWindow
                    title={t({ en: 'sender', es: 'emisor' })}
                    className="min-w-0"
                  >
                    {sender.map(({ command, comment }, index) => (
                      <div key={command}>
                        {index > 0 && <TerminalGap />}
                        <TerminalCommand>{command}</TerminalCommand>
                        <TerminalComment>{t(comment)}</TerminalComment>
                      </div>
                    ))}
                  </TerminalWindow>
                  <TerminalWindow
                    title={t({ en: 'receiver', es: 'receptor' })}
                    className="min-w-0"
                  >
                    {receiver.map(({ command, comment }, index) => (
                      <div key={command}>
                        {index > 0 && <TerminalGap />}
                        <TerminalCommand>{command}</TerminalCommand>
                        <TerminalComment>{t(comment)}</TerminalComment>
                      </div>
                    ))}
                  </TerminalWindow>
                </div>
                <div className="mt-4 flex gap-3 rounded-2xl border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  <Globe className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <p>{t(withBrowser)}</p>
                </div>
              </TabsContent>
            ),
          )}
        </Tabs>
      </SectionContainer>

      {/* Why */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">
            {t({
              en: 'Why use the terminal',
              es: 'Por qué usar la terminal',
            })}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t({
              en: 'It is the same transfer, with what a process has and a page does not.',
              es: 'Es la misma transferencia, con lo que tiene un proceso y no tiene una página web.',
            })}
          </p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          {REASONS.map(({ icon: Icon, title, description }) => (
            <div
              key={title.en}
              className="rounded-2xl border bg-card p-6 shadow-sm"
            >
              <div className="inline-flex rounded-xl bg-primary/10 p-2.5 text-primary">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-base font-semibold">{t(title)}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {t(description)}
              </p>
            </div>
          ))}
        </div>
      </SectionContainer>

      {/* Install details */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">
            {t({ en: 'Install', es: 'Instalación' })}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t({
              en: 'One executable for Linux x64, Linux arm64, Apple silicon macOS and Windows x64, with no runtime or package manager to install.',
              es: 'Un único ejecutable para Linux x64, Linux arm64, macOS con Apple silicon y Windows x64, sin entorno de ejecución ni gestor de paquetes que instalar.',
            })}
          </p>
        </div>
        <div className="mx-auto mt-8 max-w-5xl space-y-6 rounded-2xl border bg-card p-6 shadow-sm">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              {t({ en: 'Linux and macOS', es: 'Linux y macOS' })}
            </p>
            <CopyCommand command={PTRANSFER_CLI_INSTALL_SH} />
            <p className="text-xs text-muted-foreground">
              {t({
                en: (
                  <>
                    The installer picks the executable for your machine, checks
                    it against its published checksum, and puts it in{' '}
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
                  </>
                ),
                es: (
                  <>
                    El instalador elige el ejecutable para tu equipo, lo
                    comprueba con su suma de verificación publicada y lo deja en{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ~/.local/bin
                    </code>{' '}
                    sin sudo. Te avisa si otro{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ptransfer
                    </code>{' '}
                    que aparece antes en tu{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      PATH
                    </code>{' '}
                    se ejecutaría en su lugar.
                  </>
                ),
              })}
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              {t({
                en: 'Windows, in PowerShell',
                es: 'Windows, en PowerShell',
              })}
            </p>
            <CopyCommand command={PTRANSFER_CLI_INSTALL_PS1} prompt="PS>" />
            <p className="text-xs text-muted-foreground">
              {t({
                en: (
                  <>
                    Checks the download the same way, installs to{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      %LOCALAPPDATA%\Programs\ptransfer
                    </code>{' '}
                    without administrator rights, and adds that folder to your{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      PATH
                    </code>
                    . Its terminal UI is tested in Windows Terminal, and works
                    in the older console host too. Its options,{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      -Prerelease
                    </code>
                    ,{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      -DownloadOnly
                    </code>{' '}
                    and{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      -Tag
                    </code>
                    , are in the README.
                  </>
                ),
                es: (
                  <>
                    Comprueba la descarga de la misma forma, instala en{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      %LOCALAPPDATA%\Programs\ptransfer
                    </code>{' '}
                    sin permisos de administrador y añade esa carpeta a tu{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      PATH
                    </code>
                    . Su interfaz de terminal se prueba en Windows Terminal y
                    también funciona en la consola clásica de Windows. Sus
                    opciones,{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      -Prerelease
                    </code>
                    ,{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      -DownloadOnly
                    </code>{' '}
                    y{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      -Tag
                    </code>
                    , se describen en el README.
                  </>
                ),
              })}
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              {t({
                en: 'Newest prerelease, on Linux and macOS',
                es: 'Última versión preliminar, en Linux y macOS',
              })}
            </p>
            <CopyCommand
              command={`${PTRANSFER_CLI_INSTALL_SH} -s -- --prerelease`}
            />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              {t({
                en: 'Download only, into the current directory, on Linux and macOS',
                es: 'Solo descargar, en el directorio actual, en Linux y macOS',
              })}
            </p>
            <CopyCommand
              command={`${PTRANSFER_CLI_INSTALL_SH} -s -- --download-only`}
            />
            <p className="text-xs text-muted-foreground">
              {t({
                en: (
                  <>
                    Or download{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ptransfer-linux-amd64
                    </code>
                    ,{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ptransfer-linux-arm64
                    </code>
                    ,{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ptransfer-macos-arm64
                    </code>{' '}
                    or{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ptransfer-windows-amd64.exe
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
                    it on Linux and macOS; Windows may warn about an unsigned
                    download, which the installer avoids. A release tag after{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      -s --
                    </code>{' '}
                    installs that release instead of the latest.
                  </>
                ),
                es: (
                  <>
                    O descarga tú mismo{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ptransfer-linux-amd64
                    </code>
                    ,{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ptransfer-linux-arm64
                    </code>
                    ,{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ptransfer-macos-arm64
                    </code>{' '}
                    o{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      ptransfer-windows-amd64.exe
                    </code>{' '}
                    desde{' '}
                    <a
                      href={PTRANSFER_CLI_RELEASES_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClass}
                    >
                      Versiones
                    </a>{' '}
                    y dale permisos con{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      chmod +x
                    </code>{' '}
                    en Linux y macOS; Windows puede advertir de una descarga sin
                    firmar, cosa que el instalador evita. Una etiqueta de
                    versión después de{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">
                      -s --
                    </code>{' '}
                    instala esa versión en lugar de la más reciente.
                  </>
                ),
              })}
            </p>
          </div>
          <div className="border-t pt-4 text-xs text-muted-foreground">
            {t({
              en: (
                <>
                  Every command, flag and option is documented in{' '}
                  <a
                    href={PTRANSFER_CLI_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    the README
                  </a>
                  . For files larger than 2 GiB, use{' '}
                  <a
                    href={BEAM_RS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    beam-rs
                  </a>
                  .
                </>
              ),
              es: (
                <>
                  Todos los comandos, opciones y parámetros están documentados
                  en{' '}
                  <a
                    href={PTRANSFER_CLI_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    el README
                  </a>
                  . Para archivos de más de 2 GiB, usa{' '}
                  <a
                    href={BEAM_RS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    beam-rs
                  </a>
                  .
                </>
              ),
            })}
          </div>
        </div>
      </SectionContainer>
    </div>
  );
}
