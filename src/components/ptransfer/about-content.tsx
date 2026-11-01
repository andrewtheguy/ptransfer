import {
  ArrowRight,
  KeyRound,
  Lock,
  QrCode,
  Shield,
  Terminal,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  CodeModeIllustration,
  PinModeIllustration,
} from '@/components/illustrations';
import { SectionContainer } from '@/components/section-container';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/locale-context';
import { LocaleLink } from '@/i18n/locale-link';
import { OFFLINE_QR_TRANSFER_URL, PTRANSFER_REPO_URL } from '@/lib/constants';
import type { Localized } from '@/lib/i18n';
import { generateTextQRCode } from '@/lib/qr-utils';

const VALUE_PROPS = [
  {
    icon: Lock,
    label: { en: 'End-to-end encrypted', es: 'Cifrado de extremo a extremo' },
  },
  { icon: Zap, label: { en: 'Direct P2P or Tor', es: 'P2P directo o Tor' } },
  { icon: Shield, label: { en: 'No sign-up', es: 'Sin registro' } },
] as const;

interface SpecItem {
  label: Localized;
  value: Localized;
}

// Shared by every transfer, whatever mode you use.
const COMMON_DETAILS: SpecItem[] = [
  {
    label: { en: 'Content encryption:', es: 'Cifrado del contenido:' },
    value: { en: 'AES-256-GCM', es: 'AES-256-GCM' },
  },
  {
    label: { en: 'Transport choices:', es: 'Opciones de transporte:' },
    value: {
      en: 'Direct WebRTC or a Tor onion circuit',
      es: 'WebRTC directo o un circuito onion de Tor',
    },
  },
  {
    label: { en: 'Size limits:', es: 'Límites de tamaño:' },
    value: {
      en: '2 GiB over direct WebRTC; 100 MiB for relay and Tor file paths. For larger files, use beam-rs',
      es: '2 GiB por WebRTC directo; 100 MiB por relays y por Tor. Para archivos más grandes, usa beam-rs',
    },
  },
];

// Specific to PIN Exchange.
const PIN_DETAILS: SpecItem[] = [
  {
    label: { en: 'Key exchange:', es: 'Intercambio de claves:' },
    value: {
      en: 'SPAKE2 password-authenticated key exchange over the PIN, which then carries a Code Exchange ECDH exchange for you',
      es: 'Intercambio de claves autenticado por contraseña SPAKE2 sobre el PIN, que luego lleva por ti un intercambio ECDH de Intercambio por código',
    },
  },
  {
    label: { en: 'PIN format:', es: 'Formato del PIN:' },
    value: {
      en: '12 case-sensitive letters and digits: 3 public locator characters, 8 secret characters, and a checksum. With anonymous signaling on it is 16, with 12 secret characters',
      es: '12 letras y dígitos que distinguen mayúsculas de minúsculas: 3 caracteres públicos de localización, 8 caracteres secretos y un dígito de control. Con la señalización anónima activada son 16, con 12 caracteres secretos',
    },
  },
  {
    label: { en: 'PIN rotation:', es: 'Rotación del PIN:' },
    value: {
      en: 'Fresh PIN every 2 minutes; only the current and previous time buckets work',
      es: 'Un PIN nuevo cada 2 minutos; solo valen el intervalo de tiempo actual y el anterior',
    },
  },
  {
    label: { en: 'Confirmation code:', es: 'Código de confirmación:' },
    value: {
      en: 'The receiver shows an 8-character code the sender must enter; nothing is sent until it matches, so a copied PIN alone cannot pull the file',
      es: 'El receptor muestra un código de 8 caracteres que el emisor debe introducir; no se envía nada hasta que coincide, así que un PIN copiado no basta para llevarse el archivo',
    },
  },
  {
    label: { en: 'Sender wait window:', es: 'Espera del emisor:' },
    value: {
      en: '30 minutes before an unclaimed transfer gives up',
      es: '30 minutos antes de abandonar una transferencia que nadie ha reclamado',
    },
  },
  {
    label: { en: 'Signaling:', es: 'Señalización:' },
    value: { en: 'Relay signaling', es: 'Señalización por relays' },
  },
  {
    label: { en: 'Fallback:', es: 'Respaldo:' },
    value: {
      en: "Code Exchange's: public Nostr relays, or Tor with anonymous signaling on, for eligible files up to 100 MiB",
      es: 'El de Intercambio por código: relays públicos de Nostr, o Tor con la señalización anónima activada, para archivos admitidos de hasta 100 MiB',
    },
  },
  {
    label: { en: 'Anonymous signaling:', es: 'Señalización anónima:' },
    value: {
      en: 'Optional and experimental: the sender turns it on, the PIN comes out longer, and both sides carry the handshake through Tor to onion-service relays instead. A direct file transfer is unaffected; the fallback goes through Tor',
      es: 'Opcional y experimental: el emisor la activa, el PIN sale más largo y ambos extremos llevan la negociación a través de Tor hasta relays que funcionan como servicios onion. Una transferencia directa no cambia; el respaldo pasa por Tor',
    },
  },
];

// Specific to Code Exchange.
const QR_DETAILS: SpecItem[] = [
  {
    label: { en: 'Key exchange:', es: 'Intercambio de claves:' },
    value: { en: 'ECDH', es: 'ECDH' },
  },
  {
    label: { en: 'Signaling:', es: 'Señalización:' },
    value: {
      en: 'Offer and answer both by QR/copy-paste; relays are used only by a fallback',
      es: 'Oferta y respuesta, ambas por código QR o copiando y pegando; los relays solo se usan como respaldo',
    },
  },
  {
    label: { en: 'Response check:', es: 'Verificación de la respuesta:' },
    value: {
      en: 'The response carries a tag derived from the shared key, the code it answers, and its own contents; the sender verifies it automatically, so a response from another transfer or altered in transit is refused. Nothing to read out or type',
      es: 'La respuesta lleva una etiqueta derivada de la clave compartida, del código al que responde y de su propio contenido; el emisor la verifica automáticamente, así que se rechaza una respuesta de otra transferencia o alterada por el camino. No hay nada que dictar ni escribir',
    },
  },
  {
    label: { en: 'Anonymous fallback:', es: 'Respaldo anónimo:' },
    value: {
      en: 'Optional and experimental: onion-service relays carry control messages and a temporary onion service carries the file',
      es: 'Opcional y experimental: relays que funcionan como servicios onion llevan los mensajes de control y un servicio onion temporal lleva el archivo',
    },
  },
];

// Specific to Tor Onion Service.
const TOR_DETAILS: SpecItem[] = [
  {
    label: { en: 'Rendezvous:', es: 'Punto de encuentro:' },
    value: {
      en: 'A v3 onion address and one-time password shared with the receiver',
      es: 'Una dirección onion v3 y una contraseña de un solo uso compartidas con el receptor',
    },
  },
  {
    label: { en: 'Authentication:', es: 'Autenticación:' },
    value: {
      en: 'SPAKE2 over the one-time password',
      es: 'SPAKE2 sobre la contraseña de un solo uso',
    },
  },
  {
    label: { en: 'Transport:', es: 'Transporte:' },
    value: {
      en: 'A Tor onion circuit; no file-transfer WebRTC, Nostr, or direct peer connection',
      es: 'Un circuito onion de Tor; sin WebRTC para el archivo, sin Nostr y sin conexión directa entre los dispositivos',
    },
  },
  {
    label: { en: 'Size limit:', es: 'Límite de tamaño:' },
    value: {
      en: '100 MiB; transfers over 1 MiB are allowed but flagged as slow',
      es: '100 MiB; se permiten transferencias de más de 1 MiB, pero se avisa de que serán lentas',
    },
  },
];

function SpecList({ items }: { items: readonly SpecItem[] }) {
  const t = useT();
  return (
    <dl className="mt-4 grid gap-x-6 gap-y-2 rounded-xl bg-muted/40 p-4 sm:grid-cols-2">
      {items.map(({ label, value }) => (
        <div key={label.en} className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-foreground">{t(label)}</dt>
          <dd className="text-xs text-muted-foreground">{t(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AboutContent() {
  const t = useT();
  const siteUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const [shareQrUrl, setShareQrUrl] = useState<string | null>(null);
  const [shareQrError, setShareQrError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!siteUrl) return;
    void (async () => {
      try {
        const url = await generateTextQRCode(siteUrl, {
          width: 220,
          errorCorrectionLevel: 'M',
        });
        if (active) setShareQrUrl(url);
      } catch (err) {
        if (active)
          setShareQrError(
            err instanceof Error
              ? err.message
              : t({
                  en: 'Failed to generate QR code',
                  es: 'No se pudo generar el código QR',
                }),
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [siteUrl, t]);

  return (
    <div className="flex flex-col gap-16 pb-8 sm:gap-24">
      {/* What is pTransfer */}
      <SectionContainer className="pt-2 sm:pt-6">
        <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {t({ en: 'What is pTransfer?', es: '¿Qué es pTransfer?' })}
          </h1>

          <div className="mt-5 space-y-4 text-pretty text-base text-muted-foreground">
            <p>
              {t({
                en: 'pTransfer is a free, open-source tool for sending files and folders straight from one device to another with end-to-end encryption. Your content is encrypted in your browser and first tries a direct peer-to-peer connection in the two WebRTC modes. If that connection cannot be established, eligible Code Exchange files can use the selected encrypted fallback: public Nostr relays ordinarily, or Tor with the experimental anonymous option.',
                es: 'pTransfer es una herramienta gratuita y de código abierto para enviar archivos y carpetas directamente de un dispositivo a otro con cifrado de extremo a extremo. Tu contenido se cifra en tu navegador y, en los dos modos WebRTC, primero intenta una conexión directa entre dispositivos. Si esa conexión no se puede establecer, los archivos admitidos en Intercambio por código pueden usar el respaldo cifrado elegido: normalmente relays públicos de Nostr, o Tor con la opción anónima experimental.',
              })}
            </p>
            <p>
              {t({
                en: 'There are no accounts and no tracking. Each transfer uses a fresh, throwaway identity, and the whole app is a static site with no backend, no database, and nothing to sign up for. It also installs as a Progressive Web App, so it keeps working offline.',
                es: 'No hay cuentas ni rastreo. Cada transferencia usa una identidad nueva y desechable, y toda la aplicación es un sitio estático sin backend, sin base de datos y sin nada en lo que registrarse. Además se instala como aplicación web progresiva (PWA), así que sigue funcionando sin conexión.',
              })}
            </p>
            <p>
              {t({
                en: (
                  <>
                    You hand something to the recipient in every mode; the three
                    transfer modes differ in what you carry. A short{' '}
                    <span className="font-medium text-foreground">PIN</span>{' '}
                    lets relays set up the handshake for you, while a{' '}
                    <span className="font-medium text-foreground">
                      Code Exchange
                    </span>{' '}
                    carries the whole connection code (QR code or copy/paste)
                    and can even work offline on the same local network. A{' '}
                    <span className="font-medium text-foreground">
                      Tor Onion Service
                    </span>{' '}
                    transfer uses an onion address and one-time password
                    instead.
                  </>
                ),
                es: (
                  <>
                    En todos los modos le entregas algo al receptor; los tres
                    modos de transferencia se diferencian en qué le pasas. Con
                    un <span className="font-medium text-foreground">PIN</span>{' '}
                    corto, los relays preparan la negociación por ti, mientras
                    que con{' '}
                    <span className="font-medium text-foreground">
                      Intercambio por código
                    </span>{' '}
                    pasas el código de conexión completo (por código QR o
                    copiando y pegando), y puede funcionar incluso sin internet
                    en la misma red local. Con el modo{' '}
                    <span className="font-medium text-foreground">
                      Servicio onion de Tor
                    </span>
                    , en cambio, se usa una dirección onion y una contraseña de
                    un solo uso.
                  </>
                ),
              })}
            </p>
          </div>

          <ul className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            {VALUE_PROPS.map(({ icon: Icon, label }) => (
              <li key={label.en} className="inline-flex items-center gap-1.5">
                <Icon className="h-4 w-4 text-primary" />
                {t(label)}
              </li>
            ))}
          </ul>
        </div>
      </SectionContainer>

      {/* Technical Details */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">
            {t({ en: 'Technical details', es: 'Detalles técnicos' })}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t({
              en: 'Core properties and limits across all transfer modes.',
              es: 'Propiedades y límites comunes a todos los modos de transferencia.',
            })}
          </p>
        </div>
        <dl className="mt-8 grid gap-x-8 gap-y-3 rounded-2xl bg-muted/40 p-6 sm:grid-cols-3 sm:p-8">
          {COMMON_DETAILS.map(({ label, value }) => (
            <div key={label.en} className="flex flex-col gap-0.5">
              <dt className="text-sm font-medium text-foreground">
                {t(label)}
              </dt>
              <dd className="text-sm text-muted-foreground">{t(value)}</dd>
            </div>
          ))}
        </dl>
      </SectionContainer>

      {/* Transfer Modes */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">
            {t({ en: 'Three ways to connect', es: 'Tres formas de conectar' })}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t({
              en: 'Every transfer is end-to-end encrypted. The modes differ in how the devices meet and how the file travels.',
              es: 'Todas las transferencias van cifradas de extremo a extremo. Los modos se diferencian en cómo se encuentran los dispositivos y por dónde viaja el archivo.',
            })}
          </p>
        </div>
        <div className="mt-10 grid gap-6">
          <div className="grid gap-5 rounded-2xl border bg-card p-6 shadow-sm sm:grid-cols-[200px_1fr] sm:items-start sm:gap-7">
            <PinModeIllustration className="mx-auto w-full max-w-[200px] sm:mx-0" />
            <div>
              <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <KeyRound className="h-5 w-5 text-primary" />
                {t({ en: 'PIN Exchange', es: 'Intercambio por PIN' })}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t({
                  en: 'PIN Exchange uses an end-to-end encrypted direct WebRTC transfer. Instead of you carrying the whole connection code, the app carries it for you through third-party Nostr relays, sealed under a SPAKE2 exchange driven by the PIN you share — so it reaches the same direct connection and the same fallbacks as Code Exchange.',
                  es: 'Intercambio por PIN usa una transferencia WebRTC directa cifrada de extremo a extremo. En lugar de que tú pases el código de conexión completo, la aplicación lo lleva por ti a través de relays de Nostr de terceros, sellado con un intercambio SPAKE2 basado en el PIN que compartes; así llega a la misma conexión directa y a los mismos respaldos que Intercambio por código.',
                })}
              </p>
              <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>
                  {t({
                    en: 'Best when carrying a long code is impractical — no camera, a blocked clipboard, or devices that are not side by side. A short PIN is all you have to move.',
                    es: 'Ideal cuando pasar un código largo no es práctico: sin cámara, con el portapapeles bloqueado o con dispositivos que no están uno al lado del otro. Solo tienes que pasar un PIN corto.',
                  })}
                </li>
                <li>
                  {t({
                    en: 'PIN is shared out-of-band (chat, voice, etc.), then receiver enters it to find and authenticate the sender — the actual decryption key comes from a password-authenticated key exchange (SPAKE2) with fresh ephemeral keys on both devices, so the PIN alone unlocks nothing after the fact.',
                    es: 'El PIN se comparte por otro canal (chat, voz, etc.) y el receptor lo introduce para encontrar y autenticar al emisor. La clave de descifrado real sale de un intercambio de claves autenticado por contraseña (SPAKE2) con claves efímeras nuevas en ambos dispositivos, así que el PIN por sí solo no desbloquea nada a posteriori.',
                  })}
                </li>
                <li>
                  {t({
                    en: 'Relay servers coordinate signaling only; they do not get plaintext file contents or your decryption key.',
                    es: 'Los servidores relay solo coordinan la señalización; no reciben el contenido de los archivos en claro ni tu clave de descifrado.',
                  })}
                </li>
                <li>
                  {t({
                    en: "The experimental Anonymous signaling option, which the sender turns on and the recipient's page detects from the longer PIN, routes both devices' relay connections through Tor to relays run as onion services. It is slower and less reliable, and it does not anonymize the direct WebRTC connection or STUN; if no direct connection forms, the file goes through Tor rather than public relays.",
                    es: 'La opción experimental de señalización anónima, que activa el emisor y que la página del receptor detecta por el PIN más largo, envía las conexiones de ambos dispositivos con los relays a través de Tor, hacia relays que funcionan como servicios onion. Es más lenta y menos fiable, y no anonimiza la conexión WebRTC directa ni STUN; si no se logra una conexión directa, el archivo pasa por Tor en lugar de por relays públicos.',
                  })}
                </li>
                <li>
                  {t({
                    en: "File data goes directly peer-to-peer over WebRTC whenever a direct route exists. PIN Exchange's signaling relays never carry file contents; only a failed direct connection hands an eligible file to Code Exchange's fallback.",
                    es: 'Los datos del archivo van directamente de un dispositivo a otro por WebRTC siempre que exista una ruta directa. Los relays de señalización de Intercambio por PIN nunca llevan el contenido de los archivos; solo si falla la conexión directa, un archivo admitido pasa al respaldo de Intercambio por código.',
                  })}
                </li>
              </ul>
              <SpecList items={PIN_DETAILS} />
            </div>
          </div>
          <div className="grid gap-5 rounded-2xl border bg-card p-6 shadow-sm sm:grid-cols-[200px_1fr] sm:items-start sm:gap-7">
            <CodeModeIllustration className="mx-auto w-full max-w-[200px] sm:mx-0" />
            <div>
              <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <QrCode className="h-5 w-5 text-primary" />
                {t({ en: 'Code Exchange', es: 'Intercambio por código' })}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t({
                  en: "Coordination starts by handing the recipient a signaling payload — by QR code or copy/paste — with no account and no coordination server holding it. That payload is obfuscated, not encrypted, so hand it only to the intended recipient. The recipient hands the response back the same way — by QR or copy/paste — and it only enters the sender's page when the sender scans or pastes it. STUN may help find a direct route when internet is available. If direct WebRTC fails, an eligible encrypted file up to 100 MiB can use the selected fallback: temporary public Nostr relays by default, or Tor when the experimental anonymous option is on.",
                  es: 'La coordinación empieza cuando le entregas al receptor un paquete de señalización, por código QR o copiando y pegando, sin cuentas y sin ningún servidor de coordinación que lo guarde. Ese paquete está ofuscado, no cifrado, así que entrégaselo solo a quien deba recibirlo. El receptor te devuelve la respuesta de la misma forma, por código QR o copiando y pegando, y solo llega a la página del emisor cuando este la escanea o la pega. STUN puede ayudar a encontrar una ruta directa si hay conexión a internet. Si falla el WebRTC directo, un archivo cifrado admitido de hasta 100 MiB puede usar el respaldo elegido: relays públicos temporales de Nostr de forma predeterminada, o Tor si la opción anónima experimental está activada.',
                })}
              </p>
              <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>
                  {t({
                    en: 'Best when you prefer direct device-to-device coordination using camera scan or copy/paste.',
                    es: 'Ideal si prefieres coordinar directamente de dispositivo a dispositivo, escaneando con la cámara o copiando y pegando.',
                  })}
                </li>
                <li>
                  {t({
                    en: 'The offer is handed to the recipient directly — as a QR code or by copy/paste — with no relay coordination service holding it, and the response comes back the same way.',
                    es: 'La oferta se le entrega directamente al receptor, como código QR o copiando y pegando, sin ningún servicio de coordinación por relays que la guarde, y la respuesta vuelve por el mismo camino.',
                  })}
                </li>
                <li>
                  {t({
                    en: 'With internet, STUN can assist direct candidate discovery using only connection metadata (for example IP address and port), but it does not relay file traffic.',
                    es: 'Con internet, STUN puede ayudar a descubrir candidatos para la conexión directa usando solo metadatos de conexión (por ejemplo, dirección IP y puerto), pero no retransmite el tráfico de los archivos.',
                  })}
                </li>
                <li>
                  {t({
                    en: 'Without internet, transfer can still work over a shared local network with no third-party servers.',
                    es: 'Sin internet, la transferencia puede funcionar igualmente en una red local compartida, sin servidores de terceros.',
                  })}
                </li>
                <li>
                  {t({
                    en: 'The initial handoff adds the variables of camera quality, lighting, or clipboard access.',
                    es: 'La entrega inicial depende de factores como la calidad de la cámara, la iluminación o el acceso al portapapeles.',
                  })}
                </li>
              </ul>
              <SpecList items={QR_DETAILS} />
            </div>
          </div>
          <div className="grid gap-5 rounded-2xl border bg-card p-6 shadow-sm sm:grid-cols-[200px_1fr] sm:items-start sm:gap-7">
            <div className="mx-auto flex aspect-square w-full max-w-[200px] items-center justify-center rounded-2xl bg-muted/50 sm:mx-0">
              <Shield className="h-20 w-20 text-primary" />
            </div>
            <div>
              <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <Shield className="h-5 w-5 text-primary" />
                {t({ en: 'Tor Onion Service', es: 'Servicio onion de Tor' })}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t({
                  en: 'The sending tab publishes a temporary v3 onion service and shows an onion address plus a one-time password. The recipient connects through Tor, authenticates with SPAKE2, and receives the encrypted file inside the onion circuit. This mode does not use WebRTC or Nostr for the peer transfer and never creates a direct network path between the devices.',
                  es: 'La pestaña que envía publica un servicio onion v3 temporal y muestra una dirección onion y una contraseña de un solo uso. El receptor se conecta a través de Tor, se autentica con SPAKE2 y recibe el archivo cifrado dentro del circuito onion. Este modo no usa WebRTC ni Nostr para la transferencia y nunca crea una ruta de red directa entre los dispositivos.',
                })}
              </p>
              <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                <li>
                  {t({
                    en: 'Best when avoiding a direct connection matters more than speed or reliability.',
                    es: 'Ideal cuando evitar una conexión directa importa más que la velocidad o la fiabilidad.',
                  })}
                </li>
                <li>
                  {t({
                    en: 'Both devices need internet and independently enter Tor through a Snowflake bridge before meeting inside the network.',
                    es: 'Ambos dispositivos necesitan internet y entran en Tor por separado a través de un puente Snowflake antes de encontrarse dentro de la red.',
                  })}
                </li>
                <li>
                  {t({
                    en: "The sender's tab must remain open while its onion service is published, and interrupted transfers cannot resume.",
                    es: 'La pestaña del emisor debe seguir abierta mientras su servicio onion esté publicado, y las transferencias interrumpidas no se pueden reanudar.',
                  })}
                </li>
                <li>
                  {t({
                    en: (
                      <>
                        Either end can be a terminal instead:{' '}
                        <LocaleLink
                          to="/cli"
                          className="font-medium underline underline-offset-2"
                        >
                          the command line
                        </LocaleLink>{' '}
                        publishes an onion service this page connects to, and
                        connects to one this page published.
                      </>
                    ),
                    es: (
                      <>
                        Cualquiera de los dos extremos puede ser una terminal:{' '}
                        <LocaleLink
                          to="/cli"
                          className="font-medium underline underline-offset-2"
                        >
                          la línea de comandos
                        </LocaleLink>{' '}
                        publica un servicio onion al que se conecta esta página,
                        y se conecta a uno publicado por esta página.
                      </>
                    ),
                  })}
                </li>
              </ul>
              <SpecList items={TOR_DETAILS} />
            </div>
          </div>
        </div>
        <div className="mt-6 flex gap-3 rounded-2xl border border-dashed bg-muted/30 p-5 text-sm text-muted-foreground">
          <QrCode className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <p>
            {t({
              en: (
                <>
                  Both WebRTC modes try a direct route first, and neither
                  configures a TURN server. If no direct route exists, either
                  can use its selected encrypted fallback for eligible files up
                  to 100 MiB, but both the public-relay and Tor options are
                  best-effort too. Tor Onion Service is a separate mode and
                  creates no WebRTC connection between the peers. If a transfer
                  cannot complete and the devices are together, transfer the
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
                </>
              ),
              es: (
                <>
                  Los dos modos WebRTC intentan primero una ruta directa, y
                  ninguno configura un servidor TURN. Si no hay ruta directa,
                  cualquiera de los dos puede usar el respaldo cifrado elegido
                  para archivos admitidos de hasta 100 MiB, aunque tanto la
                  opción de relays públicos como la de Tor funcionan también sin
                  garantías. El modo Servicio onion de Tor es independiente y no
                  crea ninguna conexión WebRTC entre los dispositivos. Si una
                  transferencia no puede completarse y los dispositivos están
                  juntos, transfiere el archivo sin conexión con códigos QR
                  animados usando{' '}
                  <a
                    href={OFFLINE_QR_TRANSFER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    Secure QR Transfer
                  </a>
                  .
                </>
              ),
            })}
          </p>
        </div>
      </SectionContainer>

      {/* The command line */}
      <SectionContainer>
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 rounded-2xl border bg-card p-6 text-center shadow-sm sm:flex-row sm:text-left">
          <div className="inline-flex shrink-0 rounded-xl bg-primary/10 p-3 text-primary">
            <Terminal className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-semibold">
              {t({
                en: 'Also on the command line',
                es: 'También en la línea de comandos',
              })}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t({
                en: (
                  <>
                    <span className="font-medium text-foreground">
                      ptransfer
                    </span>{' '}
                    is this app in a terminal on Linux, macOS and Windows. It
                    runs the same protocol, crypto and Tor code, so either end
                    of a transfer, in any of the three modes, can be a tab or a
                    terminal.
                  </>
                ),
                es: (
                  <>
                    <span className="font-medium text-foreground">
                      ptransfer
                    </span>{' '}
                    es esta aplicación en una terminal de Linux, macOS y
                    Windows. Usa el mismo código de protocolo, cifrado y Tor,
                    así que cualquiera de los dos extremos de una transferencia,
                    en cualquiera de los tres modos, puede ser una pestaña o una
                    terminal.
                  </>
                ),
              })}
            </p>
          </div>
          <Button asChild variant="outline" className="shrink-0 gap-2">
            <LocaleLink to="/cli">
              {t({ en: 'Get the CLI', es: 'Descargar la CLI' })}
              <ArrowRight className="h-4 w-4" />
            </LocaleLink>
          </Button>
        </div>
      </SectionContainer>

      {/* Share App */}
      <SectionContainer>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl">
            {t({ en: 'Share the app', es: 'Comparte la aplicación' })}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t({
              en: 'Scan to open pTransfer on another device.',
              es: 'Escanea para abrir pTransfer en otro dispositivo.',
            })}
          </p>
        </div>
        <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-4 rounded-2xl border bg-muted/40 p-6">
          {shareQrUrl && !shareQrError ? (
            <div className="flex flex-col items-center gap-2">
              <img
                src={shareQrUrl}
                alt={t({
                  en: 'Scan to open on mobile',
                  es: 'Escanea para abrir en el móvil',
                })}
                className="h-[220px] w-[220px] rounded-md border bg-white p-2"
              />
              <p className="text-xs text-muted-foreground">
                {t({
                  en: 'Scan to open on mobile',
                  es: 'Escanea para abrir en el móvil',
                })}
              </p>
            </div>
          ) : shareQrError ? (
            <div className="text-xs text-destructive">{shareQrError}</div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {t({
                en: 'Generating QR code...',
                es: 'Generando el código QR...',
              })}
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
          {t({
            en: (
              <>
                Source code available for audit at{' '}
                <a
                  href={PTRANSFER_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  GitHub
                </a>
                , where the{' '}
                <LocaleLink to="/cli" className="text-primary hover:underline">
                  command line
                </LocaleLink>{' '}
                lives beside it
              </>
            ),
            es: (
              <>
                El código fuente está disponible para auditarlo en{' '}
                <a
                  href={PTRANSFER_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  GitHub
                </a>
                , junto con el de la{' '}
                <LocaleLink to="/cli" className="text-primary hover:underline">
                  línea de comandos
                </LocaleLink>
              </>
            ),
          })}
        </p>
      </SectionContainer>
    </div>
  );
}
