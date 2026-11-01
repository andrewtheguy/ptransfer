import {
  AlertCircle,
  Camera,
  CheckCircle2,
  ClipboardPaste,
  Download,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n/locale-context';
import { LocaleLink } from '@/i18n/locale-link';
import { ANONYMOUS_PIN_LENGTH, PIN_LENGTH } from '@/lib/crypto';
import type { Localized } from '@/lib/i18n';
import {
  classifyReceiveText,
  looksLikeOffer,
  looksLikeOnionAddress,
  looksLikePin,
  type ReceiveInput as ReceiveInputValue,
} from '@/lib/receive-input';
import { isMobileDevice } from '@/lib/utils';
import { QRScanner, type ScanResult } from './qr-scanner';

/**
 * A code that starts right and ends wrong. Worth its own words: a code is
 * carried by hand between two machines, and the way one fails is almost
 * always that something along the way cut it.
 */
const INCOMPLETE_OFFER: Localized = {
  en: "That is the start of the sender's code, but not a whole one — or it is more than an hour old. Copy it again, whole.",
  es: 'Es el comienzo del código del emisor, pero no está completo, o tiene más de una hora. Cópialo de nuevo, completo.',
};

/** How long a PIN may sit unattended in the box before it is wiped. */
const PIN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

interface ReceiveInputProps {
  onSubmit: (input: ReceiveInputValue) => void;
  /**
   * Prefills the box from a deep-linked PIN or onion address, opening on the
   * Paste tab so the value is visible before it is acted on.
   */
  initialValue?: string;
  /** Surfaced from the parent when starting the transfer itself failed. */
  error?: string | null;
  disabled?: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * The single receive surface: scan whatever the sender showed you, or paste
 * whatever they sent you. Which mode that implies is inferred from the input
 * rather than asked for up front.
 */
export function ReceiveInput({
  onSubmit,
  initialValue,
  error: startError,
  disabled,
}: ReceiveInputProps) {
  const t = useT();
  const [value, setValue] = useState(initialValue ?? '');
  const [error, setError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<'scan' | 'paste'>(
    initialValue ? 'paste' : 'scan',
  );
  // The Scan tab is the landing view, so the camera stays behind a click gate;
  // otherwise merely opening /receive would prompt for camera permission.
  const [scanStarted, setScanStarted] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [pinExpired, setPinExpired] = useState(false);

  const scanHint = isMobileDevice()
    ? t({
        en: 'Tap anywhere in this area to start the camera scanner.',
        es: 'Toca cualquier parte de esta área para iniciar el escáner de la cámara.',
      })
    : t({
        en: 'Click anywhere in this area to start the camera scanner.',
        es: 'Haz clic en cualquier parte de esta área para iniciar el escáner de la cámara.',
      });
  const classified = useMemo(() => classifyReceiveText(value), [value]);
  const pinLike = looksLikePin(value);
  const onionLike = looksLikeOnionAddress(value);
  const offerLike = useMemo(() => looksLikeOffer(value), [value]);

  // Wipe an unattended PIN. Only PINs: an offer code is not a secret, and
  // clearing one out from under someone mid-paste would just lose their work.
  useEffect(() => {
    // Derived from value here rather than read off pinLike, so that editing the
    // PIN restarts the countdown: it tracks inactivity, not the PIN's age.
    if (!looksLikePin(value)) {
      setTimeRemaining(0);
      return;
    }

    setPinExpired(false);
    setTimeRemaining(Math.ceil(PIN_INACTIVITY_TIMEOUT_MS / 1000));
    const deadline = Date.now() + PIN_INACTIVITY_TIMEOUT_MS;

    const intervalId = setInterval(() => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        clearInterval(intervalId);
        setValue('');
        setTimeRemaining(0);
        setPinExpired(true);
        return;
      }
      setTimeRemaining(Math.ceil(remainingMs / 1000));
    }, 1000);

    return () => clearInterval(intervalId);
  }, [value]);

  useEffect(() => {
    if (startError) setError(startError);
  }, [startError]);

  const handlePasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setValue(text);
      setError(null);
      setPinExpired(false);
    } catch (err) {
      console.error('Failed to paste:', err);
      setError(
        t({
          en: 'Failed to read clipboard',
          es: 'No se pudo leer el portapapeles',
        }),
      );
    }
  }, [t]);

  const handleSubmit = useCallback(() => {
    if (!value.trim()) {
      setError(
        t({
          en: 'Paste the PIN or code the sender sent you.',
          es: 'Pega el PIN o el código que te envió el emisor.',
        }),
      );
      return;
    }

    if (!classified) {
      if (pinLike) {
        setError(
          t({
            en: 'Invalid PIN — check for typos.',
            es: 'PIN no válido: revisa que esté bien escrito.',
          }),
        );
      } else if (onionLike) {
        setError(
          t({
            en: 'That onion address is not valid — check for typos.',
            es: 'Esa dirección onion no es válida: revisa que esté bien escrita.',
          }),
        );
      } else if (offerLike) {
        setError(t(INCOMPLETE_OFFER));
      } else {
        setError(
          t({
            en: 'Not a PIN, onion address, or sender code. Check that you copied the whole thing.',
            es: 'No es un PIN, una dirección onion ni un código del emisor. Comprueba que lo copiaste completo.',
          }),
        );
      }
      return;
    }

    if (classified.kind === 'offer-chunk') {
      setError(
        t({
          en: "That link is one of the sender's QR codes — use the Scan tab, or paste the text they copied.",
          es: 'Ese enlace es uno de los códigos QR del emisor: usa la pestaña Escanear o pega el texto que copió.',
        }),
      );
      return;
    }

    setError(null);
    setPinExpired(false);
    // Drop the PIN out of the DOM the moment it is handed on.
    setValue('');
    onSubmit(classified);
  }, [classified, offerLike, onionLike, onSubmit, pinLike, t, value]);

  const handleScan = useCallback(
    (result: ScanResult) => {
      setError(null);
      setPinExpired(false);
      setValue('');
      if (result.kind === 'pin') {
        onSubmit({ kind: 'pin', pin: result.pin, pinKind: result.pinKind });
      } else if (result.kind === 'onion') {
        onSubmit({ kind: 'onion', address: result.address });
      } else onSubmit({ kind: 'offer', payload: result.data });
    },
    [onSubmit],
  );

  // The scanner reports only the camera failing, not transient scan failures.
  const handleScanError = useCallback((err: string) => {
    setError(err);
  }, []);

  const handleInputModeChange = useCallback((next: 'scan' | 'paste') => {
    setError(null);
    setInputMode(next);
    if (next !== 'scan') {
      setScanStarted(false);
    }
  }, []);

  const cliLink = (
    <LocaleLink
      to="/cli"
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-foreground underline underline-offset-2"
    >
      ptransfer
    </LocaleLink>
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t({
          en: "Scan the sender's QR code, or paste the PIN, onion address, or code they sent you.",
          es: 'Escanea el código QR del emisor, o pega el PIN, la dirección onion o el código que te envió.',
        })}
      </p>

      <Tabs
        value={inputMode}
        onValueChange={(v) => handleInputModeChange(v as 'scan' | 'paste')}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="scan" disabled={disabled}>
            <Camera className="h-4 w-4 mr-2" />
            {t({ en: 'Scan', es: 'Escanear' })}
          </TabsTrigger>
          <TabsTrigger value="paste" disabled={disabled}>
            <ClipboardPaste className="h-4 w-4 mr-2" />
            {t({ en: 'Paste', es: 'Pegar' })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="mt-3">
          {scanStarted ? (
            <QRScanner
              mode="receive"
              onScan={handleScan}
              onError={handleScanError}
              disabled={disabled}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setScanStarted(true);
              }}
              disabled={disabled}
              className="w-full rounded-lg border border-dashed p-6 text-center cursor-pointer transition-colors hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Camera className="h-6 w-6 mx-auto mb-2" />
              <p className="text-base font-medium">
                {t({ en: 'Start scanning', es: 'Empezar a escanear' })}
              </p>
              <p className="text-sm text-muted-foreground mt-1">{scanHint}</p>
            </button>
          )}
        </TabsContent>

        <TabsContent value="paste" className="mt-3 space-y-2">
          <Textarea
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
              setPinExpired(false);
            }}
            placeholder={t({
              en: "Paste the PIN, onion address, or the sender's code here...",
              es: 'Pega aquí el PIN, la dirección onion o el código del emisor...',
            })}
            className="min-h-[100px] font-mono text-xs"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label={t({
              en: 'PIN, onion address, or sender code',
              es: 'PIN, dirección onion o código del emisor',
            })}
            disabled={disabled}
          />

          {classified?.kind === 'pin' && (
            <p className="text-xs text-green-600 flex items-center">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              {classified.pinKind === 'anonymous'
                ? t({
                    en: 'PIN detected — the sender turned on anonymous signaling',
                    es: 'PIN detectado: el emisor activó la señalización anónima',
                  })
                : t({ en: 'PIN detected', es: 'PIN detectado' })}
            </p>
          )}
          {classified?.kind === 'onion' && (
            <p className="text-xs text-green-600 flex items-center">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              {t({
                en: 'Onion address detected — the password comes next',
                es: 'Dirección onion detectada: la contraseña va a continuación',
              })}
            </p>
          )}
          {classified?.kind === 'offer' && (
            <p className="text-xs text-green-600 flex items-center">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              {t({
                en: "Sender's code detected",
                es: 'Código del emisor detectado',
              })}
            </p>
          )}
          {classified?.kind === 'offer-chunk' && (
            <p className="text-xs text-amber-600 flex items-center">
              <AlertCircle className="h-3 w-3 mr-1" />
              {t({
                en: "That's one of the sender's QR links — use the Scan tab instead.",
                es: 'Es uno de los enlaces QR del emisor: usa la pestaña Escanear.',
              })}
            </p>
          )}
          {!classified && offerLike && (
            <p className="text-xs text-destructive flex items-center">
              <AlertCircle className="h-3 w-3 mr-1" />
              {t(INCOMPLETE_OFFER)}
            </p>
          )}
          {!classified && pinLike && (
            <p className="text-xs text-destructive flex items-center">
              <AlertCircle className="h-3 w-3 mr-1" />
              {t({
                en: 'Invalid PIN — check for typos',
                es: 'PIN no válido: revisa que esté bien escrito',
              })}
            </p>
          )}
          {!classified && onionLike && (
            <p className="text-xs text-destructive flex items-center">
              <AlertCircle className="h-3 w-3 mr-1" />
              {t({
                en: 'Invalid onion address — check for typos',
                es: 'Dirección onion no válida: revisa que esté bien escrita',
              })}
            </p>
          )}

          {timeRemaining > 0 && (
            <p className="text-xs text-amber-600 font-medium">
              {t({
                en: `PIN will be cleared in ${formatTime(timeRemaining)}`,
                es: `El PIN se borrará en ${formatTime(timeRemaining)}`,
              })}
            </p>
          )}
          {pinExpired && (
            <p className="text-xs text-muted-foreground">
              {t({
                en: 'PIN cleared due to inactivity. Please re-enter.',
                es: 'PIN borrado por inactividad. Vuelve a introducirlo.',
              })}
            </p>
          )}

          {error && (
            <p className="text-xs text-destructive flex items-center">
              <AlertCircle className="h-3 w-3 mr-1" />
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePasteFromClipboard}
              disabled={disabled}
              className="flex-1"
            >
              <ClipboardPaste className="h-4 w-4 mr-2" />
              {t({ en: 'Paste from Clipboard', es: 'Pegar del portapapeles' })}
            </Button>

            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
              className="flex-1 bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
            >
              <Download className="h-4 w-4 mr-2" />
              {t({ en: 'Receive', es: 'Recibir' })}
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {inputMode === 'scan' && error && (
        <p className="text-xs text-destructive flex items-center">
          <AlertCircle className="h-3 w-3 mr-1" />
          {error}
        </p>
      )}

      <Collapsible className="space-y-2">
        <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
          {t({ en: 'What am I pasting?', es: '¿Qué estoy pegando?' })}
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 text-xs text-muted-foreground">
          {t({
            en: (
              <>
                <p>
                  <span className="font-medium text-foreground">
                    A short {PIN_LENGTH}-character PIN
                  </span>{' '}
                  means the sender chose PIN Exchange. Relays carry the
                  handshake and the PIN authenticates it; a confirmation code
                  appears here for you to read back to them, and nothing is sent
                  until it matches.
                </p>
                <p>
                  <span className="font-medium text-foreground">
                    A longer {ANONYMOUS_PIN_LENGTH}-character PIN
                  </span>{' '}
                  is the same exchange with anonymous signaling turned on at
                  their end. The extra length is the signal: this page
                  recognizes it and routes the handshake through Tor to the
                  relays the sender is waiting on, so no Nostr relay sees either
                  side's IP address. It asks you which Tor bridge to use and
                  then takes a while to start. The file itself still arrives
                  over a direct connection, which Tor does not cover.
                </p>
                <p>
                  <span className="font-medium text-foreground">
                    A <code>.onion</code> address
                  </span>{' '}
                  means the sender published a Tor hidden service. Enter the
                  one-time password they gave you on the next screen; the file
                  travels inside Tor, with no Nostr or pTransfer relay and no
                  direct connection between the two networks. Tor relays still
                  carry the circuits.
                </p>
                <p>
                  <span className="font-medium text-foreground">
                    A long block of text, or a grid of QR codes,
                  </span>{' '}
                  means they chose Code Exchange. Nothing about the handshake
                  touches a relay — you hand a response code back the same way
                  you got theirs. If a direct connection cannot be made, an
                  eligible encrypted file up to 100 MiB can use the automatic
                  Nostr relay fallback.
                </p>
                <p>
                  The sender does not have to be a browser. A PIN, a{' '}
                  <code>.onion</code> address, or a sender code minted by{' '}
                  {cliLink}, this app on the command line, is pasted here
                  exactly the same way — the terminal carries Code Exchange as
                  text, since it has no camera to scan a QR grid with.
                </p>
              </>
            ),
            es: (
              <>
                <p>
                  <span className="font-medium text-foreground">
                    Un PIN corto de {PIN_LENGTH} caracteres
                  </span>{' '}
                  significa que el emisor eligió Intercambio por PIN. Los relays
                  transportan la negociación y el PIN la autentica; aquí aparece
                  un código de confirmación para que se lo leas, y no se envía
                  nada hasta que coincida.
                </p>
                <p>
                  <span className="font-medium text-foreground">
                    Un PIN más largo, de {ANONYMOUS_PIN_LENGTH} caracteres,
                  </span>{' '}
                  es el mismo intercambio con la señalización anónima activada
                  en su extremo. La longitud adicional es la señal: esta página
                  la reconoce y enruta la negociación a través de Tor hacia los
                  relays en los que espera el emisor, así que ningún relay de
                  Nostr ve la dirección IP de ninguno de los dos. Te pregunta
                  qué puente de Tor usar y luego tarda un rato en arrancar. El
                  archivo en sí sigue llegando por una conexión directa, que Tor
                  no cubre.
                </p>
                <p>
                  <span className="font-medium text-foreground">
                    Una dirección <code>.onion</code>
                  </span>{' '}
                  significa que el emisor publicó un servicio oculto de Tor.
                  Introduce en la siguiente pantalla la contraseña de un solo
                  uso que te dio; el archivo viaja dentro de Tor, sin relays de
                  Nostr ni de pTransfer y sin conexión directa entre las dos
                  redes. Los relays de Tor siguen transportando los circuitos.
                </p>
                <p>
                  <span className="font-medium text-foreground">
                    Un bloque de texto largo, o una cuadrícula de códigos QR,
                  </span>{' '}
                  significa que eligió Intercambio por código. Nada de la
                  negociación pasa por un relay: devuelves un código de
                  respuesta por la misma vía por la que recibiste el suyo. Si no
                  se puede establecer una conexión directa, un archivo cifrado
                  apto de hasta 100 MiB puede usar el respaldo automático por
                  relays de Nostr.
                </p>
                <p>
                  El emisor no tiene por qué ser un navegador. Un PIN, una
                  dirección <code>.onion</code> o un código del emisor generado
                  por {cliLink}, esta aplicación en la línea de comandos, se
                  pega aquí exactamente igual: la terminal transporta el
                  Intercambio por código como texto, ya que no tiene cámara con
                  la que escanear una cuadrícula de códigos QR.
                </p>
              </>
            ),
          })}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
