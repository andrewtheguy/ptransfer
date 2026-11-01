import {
  ArrowRight,
  Download,
  FileUp,
  KeyRound,
  Lock,
  Send,
  Share2,
  Shield,
  Terminal,
  Zap,
} from 'lucide-react';
import { Hero } from '@/components/hero';
import { SectionContainer } from '@/components/section-container';
import {
  CopyCommand,
  TerminalCommand,
  TerminalComment,
  TerminalWindow,
} from '@/components/terminal';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/locale-context';
import { LocaleLink } from '@/i18n/locale-link';
import {
  PTRANSFER_CLI_INSTALL_PS1,
  PTRANSFER_CLI_INSTALL_SH,
} from '@/lib/constants';

const STEPS = [
  {
    icon: FileUp,
    title: { en: 'Pick your files', es: 'Elige tus archivos' },
    description: {
      en: 'Choose individual files or a whole folder, right on device.',
      es: 'Selecciona archivos sueltos o una carpeta entera, desde tu propio dispositivo.',
    },
  },
  {
    icon: KeyRound,
    title: { en: 'Choose a mode', es: 'Elige un modo' },
    description: {
      en: 'Use a short PIN, carry the whole connection code by QR or copy/paste, or publish a temporary Tor onion service.',
      es: 'Usa un PIN corto, pasa el código de conexión completo por código QR o copiando y pegando, o publica un servicio onion de Tor temporal.',
    },
  },
  {
    icon: Share2,
    title: {
      en: 'Share pairing info',
      es: 'Comparte los datos de emparejamiento',
    },
    description: {
      en: 'Hand over the PIN, connection code, or onion address and one-time password to your recipient.',
      es: 'Entrega al receptor el PIN, el código de conexión o la dirección onion y la contraseña de un solo uso.',
    },
  },
  {
    icon: Send,
    title: { en: 'Transfer securely', es: 'Transfiere de forma segura' },
    description: {
      en: 'Files stay end-to-end encrypted over direct WebRTC, a Code Exchange fallback, or a Tor onion circuit.',
      es: 'Los archivos viajan cifrados de extremo a extremo, ya sea por WebRTC directo, por el respaldo de Intercambio por código o por un circuito onion de Tor.',
    },
  },
] as const;

const FEATURES = [
  {
    icon: Lock,
    title: { en: 'End-to-end encryption', es: 'Cifrado de extremo a extremo' },
    description: {
      en: 'Content is encrypted with AES-256-GCM before it leaves your device. Only the paired endpoints derive the content key; the PIN itself cannot decrypt a file.',
      es: 'El contenido se cifra con AES-256-GCM antes de salir de tu dispositivo. Solo los dos extremos emparejados obtienen la clave de contenido; el PIN por sí solo no puede descifrar ningún archivo.',
    },
  },
  {
    icon: Zap,
    title: { en: 'Direct P2P or Tor', es: 'P2P directo o Tor' },
    description: {
      en: 'The WebRTC modes try a direct route first. Eligible Code Exchange files can fall back to Nostr or Tor; Tor Onion Service uses Tor from the start.',
      es: 'Los modos WebRTC intentan primero una ruta directa. Los archivos que lo admiten en Intercambio por código pueden recurrir a Nostr o Tor como respaldo; el modo de servicio onion de Tor usa Tor desde el principio.',
    },
  },
  {
    icon: Shield,
    title: { en: 'No accounts required', es: 'Sin cuentas' },
    description: {
      en: 'No sign-ups, no tracking. Each transfer uses a fresh ephemeral identity that is discarded after use.',
      es: 'Sin registros ni rastreo. Cada transferencia usa una identidad efímera nueva que se descarta al terminar.',
    },
  },
] as const;

export function HomePage() {
  const t = useT();
  return (
    <div className="flex flex-col gap-16 pb-8 sm:gap-24">
      <Hero />

      {/* How it works */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">
            {t({ en: 'How it works', es: 'Cómo funciona' })}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t({
              en: 'Four quick steps from your device to theirs — no setup needed.',
              es: 'Cuatro pasos rápidos de tu dispositivo al suyo, sin configurar nada.',
            })}
          </p>
        </div>
        <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, title, description }, index) => (
            <li
              key={title.en}
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
              <h3 className="mt-4 text-base font-semibold">{t(title)}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {t(description)}
              </p>
            </li>
          ))}
        </ol>
      </SectionContainer>

      {/* Features */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">
            {t({ en: 'Built for privacy', es: 'Pensado para la privacidad' })}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t({
              en: "Security isn't an add-on here — it's how every transfer works.",
              es: 'Aquí la seguridad no es un añadido: es la base de cada transferencia.',
            })}
          </p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div
              key={title.en}
              className="rounded-2xl border bg-card p-6 shadow-sm"
            >
              <div className="inline-flex rounded-xl bg-primary/10 p-2.5 text-primary">
                <Icon className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{t(title)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {t(description)}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-6 text-center">
          <LocaleLink
            to="/about"
            className="text-sm font-medium text-primary hover:underline"
          >
            {t({
              en: 'Learn how it stays secure →',
              es: 'Descubre cómo se mantiene seguro →',
            })}
          </LocaleLink>
        </div>
      </SectionContainer>

      {/* Command line */}
      <SectionContainer>
        <div className="grid items-center gap-8 rounded-3xl border bg-card p-6 shadow-sm sm:p-10 md:grid-cols-2">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
              <Terminal className="h-3.5 w-3.5" />
              {t({
                en: 'Linux, macOS and Windows',
                es: 'Linux, macOS y Windows',
              })}
            </span>
            <h2 className="mt-4 text-3xl">
              {t({ en: 'Also in your terminal', es: 'También en tu terminal' })}
            </h2>
            <p className="mt-3 text-muted-foreground">
              {t({
                en: (
                  <>
                    <span className="font-medium text-foreground">
                      ptransfer
                    </span>{' '}
                    brings these screens to your terminal: run it, pick files,
                    and choose a mode, or paste what a sender gave you. Either
                    end of a transfer can be a browser tab or a terminal, and
                    every mode is a command too, for scripts and servers you
                    reach over SSH.
                  </>
                ),
                es: (
                  <>
                    <span className="font-medium text-foreground">
                      ptransfer
                    </span>{' '}
                    lleva estas mismas pantallas a tu terminal: ejecútalo, elige
                    los archivos y un modo, o pega lo que te pasó el emisor.
                    Cualquiera de los dos extremos puede ser una pestaña del
                    navegador o una terminal, y cada modo es también un comando,
                    para scripts y para servidores a los que accedes por SSH.
                  </>
                ),
              })}
            </p>
            <Button asChild variant="outline" className="mt-6 gap-2">
              <LocaleLink to="/cli">
                {t({
                  en: 'Get the command line app',
                  es: 'Descarga la aplicación de línea de comandos',
                })}
                <ArrowRight className="h-4 w-4" />
              </LocaleLink>
            </Button>
          </div>
          <div className="min-w-0 space-y-3">
            <TerminalWindow title="~">
              <TerminalCommand>ptransfer</TerminalCommand>
              <TerminalComment>
                {t({
                  en: 'opens the terminal UI: pick files, then PIN, Code or Tor',
                  es: 'abre la interfaz de terminal: elige archivos y luego PIN, código o Tor',
                })}
              </TerminalComment>
            </TerminalWindow>
            <p className="text-xs font-medium text-muted-foreground">
              {t({ en: 'Linux and macOS', es: 'Linux y macOS' })}
            </p>
            <CopyCommand command={PTRANSFER_CLI_INSTALL_SH} />
            <p className="text-xs font-medium text-muted-foreground">
              {t({
                en: 'Windows, in PowerShell',
                es: 'Windows, en PowerShell',
              })}
            </p>
            <CopyCommand command={PTRANSFER_CLI_INSTALL_PS1} prompt="PS>" />
          </div>
        </div>
      </SectionContainer>

      {/* Closing CTA */}
      <SectionContainer>
        <div className="relative overflow-hidden rounded-3xl border border-primary/15 bg-gradient-to-br from-primary/10 via-background to-secondary/10 px-6 py-12 text-center sm:px-12">
          <h2 className="text-2xl sm:text-3xl">
            {t({
              en: 'Ready to send something?',
              es: '¿Listo para enviar algo?',
            })}
          </h2>
          <p className="mx-auto mt-3 max-w-md text-muted-foreground">
            {t({
              en: 'Start an encrypted transfer in seconds — no account, no upload.',
              es: 'Empieza una transferencia cifrada en segundos, sin cuenta y sin subir nada a un servidor.',
            })}
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="gap-2">
              <LocaleLink to="/send">
                <Send className="h-4 w-4" />
                {t({ en: 'Send files', es: 'Enviar archivos' })}
              </LocaleLink>
            </Button>
            <Button asChild size="lg" variant="outline" className="gap-2">
              <LocaleLink to="/receive">
                <Download className="h-4 w-4" />
                {t({ en: 'Receive files', es: 'Recibir archivos' })}
              </LocaleLink>
            </Button>
          </div>
        </div>
      </SectionContainer>
    </div>
  );
}
