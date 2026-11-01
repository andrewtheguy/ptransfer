import {
  ArrowRight,
  Download,
  Lock,
  Send,
  Shield,
  Terminal,
  Zap,
} from 'lucide-react';
import { PTransferIllustration } from '@/components/illustrations';
import { SectionContainer } from '@/components/section-container';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/locale-context';
import { LocaleLink } from '@/i18n/locale-link';

const VALUE_PROPS = [
  {
    icon: Lock,
    label: { en: 'End-to-end encrypted', es: 'Cifrado de extremo a extremo' },
  },
  { icon: Zap, label: { en: 'Direct P2P or Tor', es: 'P2P directo o Tor' } },
  { icon: Shield, label: { en: 'No sign-up', es: 'Sin registro' } },
] as const;

export function Hero() {
  const t = useT();
  return (
    <SectionContainer className="sm:pt-12 sm:pb-4">
      <div className="grid items-center gap-3 md:grid-cols-2 md:gap-8">
        <div className="flex flex-col items-center text-center md:items-start md:text-left">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
            <Lock className="h-3.5 w-3.5" />
            {t({ en: 'Private by design', es: 'Privado por diseño' })}
          </span>

          <h1 className="mt-3 text-balance bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent sm:mt-5">
            {t({
              en: 'Send files. Stay private.',
              es: 'Envía archivos. Mantén tu privacidad.',
            })}
          </h1>

          <p className="mt-3 max-w-md text-pretty text-base text-muted-foreground sm:mt-4 sm:text-lg">
            {t({
              en: 'Share files and folders straight from your device with end-to-end encryption. No accounts or central file server: use direct WebRTC with an encrypted Code Exchange fallback, or avoid a direct peer connection with Tor Onion Service.',
              es: 'Comparte archivos y carpetas directamente desde tu dispositivo con cifrado de extremo a extremo. Sin cuentas ni servidor central de archivos: usa WebRTC directo con un respaldo cifrado en Intercambio por código, o evita la conexión directa entre dispositivos con un servicio onion de Tor.',
            })}
          </p>

          <div className="mt-3 flex w-full flex-col gap-3 sm:mt-6 sm:w-auto sm:flex-row">
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

          <LocaleLink
            to="/cli"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
          >
            <Terminal className="h-4 w-4" />
            {t({
              en: 'Prefer a terminal? Get the command line app',
              es: '¿Prefieres la terminal? Descarga la aplicación de línea de comandos',
            })}
            <ArrowRight className="h-3.5 w-3.5" />
          </LocaleLink>

          <ul className="mt-6 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground md:justify-start">
            {VALUE_PROPS.map(({ icon: Icon, label }) => (
              <li key={label.en} className="inline-flex items-center gap-1.5">
                <Icon className="h-4 w-4 text-primary" />
                {t(label)}
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
