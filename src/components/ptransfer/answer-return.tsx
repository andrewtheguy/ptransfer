import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useT } from '@/i18n/locale-context';
import { QRDisplay } from './qr-display';

export interface AnswerReturnProps {
  answerData: Uint8Array;
  /**
   * Whether the relay fallback could carry this file. Without a relay path to
   * fall back to, the simulation is not offered.
   */
  relayFallbackAvailable?: boolean;
  /** Whether the response on screen is the simulated no-direct-route one. */
  simulateNoDirect?: boolean;
  onSimulateNoDirectChange?: (value: boolean) => void;
  /**
   * Whether the direct route died for real while this response was on screen.
   * The response is still what the sender needs — the fallback cannot start
   * without it — so the page stays put and only its wording changes.
   */
  directRouteDead?: boolean;
  /**
   * What the fallback is, named the way a sentence needs it. The sender's
   * code decides it, so the receiver is told rather than asked.
   */
  fallbackName?: string;
  /**
   * What the Tor client is doing, when the sender's code asked for the
   * anonymous fallback. It bootstraps behind the direct attempt, so it is the
   * one thing happening on this page that the page would otherwise not show.
   */
  torStatus?: string;
}

/**
 * The receiver's half of the answer step: the QR / copy-paste instructions.
 * The answer only ever reaches the sender through their own scan or paste.
 */
export function AnswerReturn({
  answerData,
  relayFallbackAvailable = false,
  simulateNoDirect = false,
  onSimulateNoDirectChange,
  directRouteDead = false,
  fallbackName: fallbackNameProp,
  torStatus,
}: AnswerReturnProps) {
  const t = useT();
  const fallbackName =
    fallbackNameProp ??
    t({ en: 'the Nostr relays', es: 'los relays de Nostr' });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Simulated or real, a dead route says the same thing here: the file is
  // coming through the fallback, and it still needs this response first.
  const fallbackOnly = simulateNoDirect || directRouteDead;

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-muted/50 border p-4 space-y-2">
        <p className="font-medium">
          {t({
            en: 'Send your response back to the sender',
            es: 'Envía tu respuesta de vuelta al emisor',
          })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t({
            en: 'Get your response back to the sender by the QR code below or copy/paste the data:',
            es: 'Haz llegar tu respuesta al emisor con el código QR de abajo o copiando y pegando los datos:',
          })}
        </p>
        <ul className="text-sm text-muted-foreground space-y-2">
          <li>
            {t({
              en: (
                <>
                  <span className="font-medium text-foreground">QR code:</span>{' '}
                  the sender scans the code below with the in-app scanner under{' '}
                  <strong>Scan or paste receiver's response</strong> on their
                  page.
                </>
              ),
              es: (
                <>
                  <span className="font-medium text-foreground">
                    Código QR:
                  </span>{' '}
                  el emisor escanea el código de abajo con el escáner de la
                  aplicación, en{' '}
                  <strong>Escanear o pegar la respuesta del receptor</strong> en
                  su página.
                </>
              ),
            })}
          </li>
          <li>
            {t({
              en: (
                <>
                  <span className="font-medium text-foreground">
                    Copy &amp; paste:
                  </span>{' '}
                  tap <strong>Copy Data</strong> below the code, then send the
                  copied text back to the sender over the same secure channel
                  for them to paste. If the button doesn&apos;t work, use{' '}
                  <strong>Show text to copy manually</strong> to select and copy
                  the response yourself.
                </>
              ),
              es: (
                <>
                  <span className="font-medium text-foreground">
                    Copiar y pegar:
                  </span>{' '}
                  toca <strong>Copiar datos</strong> debajo del código y después
                  envía el texto copiado al emisor por el mismo canal seguro
                  para que lo pegue. Si el botón no funciona, usa{' '}
                  <strong>Mostrar el texto para copiarlo a mano</strong> para
                  seleccionar y copiar la respuesta tú mismo.
                </>
              ),
            })}
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          {fallbackOnly
            ? t({
                en: `Keep this page open — the file comes through ${fallbackName} once the sender has your response.`,
                es: `Mantén esta página abierta: el archivo llegará a través de ${fallbackName} cuando el emisor tenga tu respuesta.`,
              })
            : t({
                en: 'Keep this page open — the transfer connects automatically once the sender has your response.',
                es: 'Mantén esta página abierta: la transferencia se conectará automáticamente cuando el emisor tenga tu respuesta.',
              })}
        </p>
      </div>

      {/* The Tor bootstrap. It costs minutes, so saying nothing would look
          like a page doing nothing. Which of the two routes it is — the one
          behind the direct attempt, or the only one left — is what the
          sentence after it settles. */}
      {torStatus && (
        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {fallbackOnly
              ? t({ en: 'Preparing Tor:', es: 'Preparando Tor:' })
              : t({
                  en: 'Preparing the Tor fallback:',
                  es: 'Preparando el respaldo por Tor:',
                })}
          </span>{' '}
          {torStatus}{' '}
          {fallbackOnly
            ? t({
                en: 'This is the route the file will take; it has to finish before the transfer can start.',
                es: 'Esta es la ruta que tomará el archivo; tiene que terminar antes de que pueda empezar la transferencia.',
              })
            : t({
                en: 'The direct connection is being tried at the same time and does not wait for this.',
                es: 'La conexión directa se está intentando al mismo tiempo y no espera a esto.',
              })}
        </div>
      )}

      {/* Advanced options: only where a relay path exists to fall back to,
          and closed by default. */}
      {relayFallbackAvailable && (
        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          className="rounded-lg border bg-muted/30 p-3"
        >
          <CollapsibleTrigger className="flex w-full items-center gap-1 text-sm font-medium">
            {t({ en: 'Advanced options', es: 'Opciones avanzadas' })}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            <div className="space-y-1">
              <span className="text-sm font-medium">
                {t({
                  en: 'No direct connection',
                  es: 'Sin conexión directa',
                })}
              </span>
              <p className="text-xs text-muted-foreground">
                {simulateNoDirect
                  ? t({
                      en: `A direct connection to this page can no longer be made, and the code below is the one with none of its network routes in it. Nothing has started yet — the file comes through ${fallbackName} once the sender takes the response in. Going back builds a working direct route again.`,
                      es: `Ya no se puede establecer una conexión directa con esta página, y el código de abajo es el que no incluye ninguna de sus rutas de red. Todavía no ha empezado nada: el archivo llegará a través de ${fallbackName} cuando el emisor reciba la respuesta. Al volver se crea de nuevo una ruta directa que funciona.`,
                    })
                  : t({
                      en: `Drops this device's direct connection and builds the response again with none of its network routes in it, so the sender has nothing to connect to and the file comes through ${fallbackName} instead. It is the situation a device behind a hostile NAT is in anyway — this only saves you having to arrange one.`,
                      es: `Descarta la conexión directa de este dispositivo y vuelve a crear la respuesta sin ninguna de sus rutas de red, así que el emisor no tiene a qué conectarse y el archivo llega a través de ${fallbackName}. Es la situación en la que está de todos modos un dispositivo detrás de un NAT hostil; esto solo te ahorra tener que preparar uno.`,
                    })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t({
                  en: 'Either way the whole connection is built from scratch, so the code below changes: hand the sender the one on screen now.',
                  es: 'En ambos casos toda la conexión se crea desde cero, así que el código de abajo cambia: pasa al emisor el que aparece ahora en pantalla.',
                })}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={!onSimulateNoDirectChange}
              onClick={() => onSimulateNoDirectChange?.(!simulateNoDirect)}
            >
              {simulateNoDirect
                ? t({
                    en: 'Go back to a direct connection',
                    es: 'Volver a una conexión directa',
                  })
                : t({
                    en: 'Simulate no direct connection',
                    es: 'Simular que no hay conexión directa',
                  })}
            </Button>
          </CollapsibleContent>
        </Collapsible>
      )}

      <QRDisplay
        data={answerData}
        label={t({ en: 'Your response', es: 'Tu respuesta' })}
      />
    </div>
  );
}
