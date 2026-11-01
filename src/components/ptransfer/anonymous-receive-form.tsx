import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/locale-context';
import type { Localized } from '@/lib/i18n';
import { DEFAULT_TOR_BRIDGE, type TorBridge } from '@/lib/tor/bridge';
import { TorBridgeChoice } from './tor-bridge-choice';

/**
 * Which exchange asked for Tor. Only the explanation differs — what Tor
 * covers is not the same in the two modes, and saying so wrongly would be
 * worse than saying nothing.
 */
export type AnonymousReceiveMode = 'pin' | 'code';

interface AnonymousReceiveFormProps {
  mode: AnonymousReceiveMode;
  onSubmit: (bridge: TorBridge) => void;
  onCancel: () => void;
}

const HEADINGS: Record<AnonymousReceiveMode, Localized> = {
  pin: { en: 'Anonymous signaling', es: 'Señalización anónima' },
  code: {
    en: 'Anonymous signaling and relay',
    es: 'Señalización y relay anónimos',
  },
};

const CONFIRM_LABELS: Record<AnonymousReceiveMode, Localized> = {
  pin: { en: 'Connect over Tor', es: 'Conectar por Tor' },
  // Nothing connects over Tor yet: the next thing on screen is the response
  // to carry back, and a direct connection is tried before Tor is used at all.
  code: { en: 'Continue', es: 'Continuar' },
};

/**
 * What the receiver sees when what it was handed turns out to have been made
 * with Tor on.
 *
 * There is nothing to ask about the mode itself — an anonymous PIN's length
 * and an anonymous sender code's own flag each settle that, and the sender is
 * waiting on the onion relay pool either way. The one open question is which
 * Snowflake bridge this device reaches Tor through, and it is worth asking
 * before starting rather than after: a bootstrap costs minutes, and a person
 * on a network that blocks the fixed endpoint should not have to spend them
 * twice to discover it.
 */
export function AnonymousReceiveForm({
  mode,
  onSubmit,
  onCancel,
}: AnonymousReceiveFormProps) {
  const t = useT();
  const [bridge, setBridge] = useState<TorBridge>(DEFAULT_TOR_BRIDGE);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {t(HEADINGS[mode])}
          <span className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {t({ en: 'Experimental', es: 'Experimental' })}
          </span>
        </p>
        {mode === 'pin' ? (
          <p className="text-xs text-muted-foreground">
            {t({
              en: "This PIN was made with anonymous signaling on, so the handshake runs through Tor inside your browser to relays run as onion services — no relay sees your IP address, or the sender's. Starting takes a while, especially the first time, and it fails more often than an ordinary PIN. The file itself still arrives over a direct WebRTC connection, which Tor does not cover: the sender and the STUN services see the same network metadata as always.",
              es: 'Este PIN se creó con la señalización anónima activada, así que la negociación pasa por Tor dentro de tu navegador hacia relays que funcionan como servicios onion: ningún relay ve tu dirección IP ni la del emisor. Iniciarlo tarda un rato, sobre todo la primera vez, y falla más a menudo que un PIN normal. El archivo en sí sigue llegando por una conexión WebRTC directa, que Tor no cubre: el emisor y los servicios STUN ven los mismos metadatos de red de siempre.',
            })}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t({
              en: "This code was made with anonymous signaling and relay on. A direct WebRTC connection is still tried first, exactly as always, and Tor does not cover it: while it is being attempted, the sender and the STUN services see the same network metadata as always. If there is no direct route, the file arrives through Tor instead — over an onion service the sending page publishes, coordinated over relays run as onion services, so no relay sees your IP address or the sender's. Your browser starts Tor now rather than then, because that is the slow part; expect it to take a while, especially the first time.",
              es: 'Este código se creó con la señalización y el relay anónimos activados. Primero se intenta una conexión WebRTC directa, exactamente como siempre, y Tor no la cubre: mientras se intenta, el emisor y los servicios STUN ven los mismos metadatos de red de siempre. Si no hay ruta directa, el archivo llega por Tor: a través de un servicio onion que publica la página del emisor, coordinado mediante relays que funcionan como servicios onion, así que ningún relay ve tu dirección IP ni la del emisor. Tu navegador inicia Tor ahora y no más tarde, porque es la parte lenta; espera que tarde un rato, sobre todo la primera vez.',
            })}
          </p>
        )}
      </div>

      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <p className="text-sm font-medium">
          {t({
            en: 'How this tab reaches Tor',
            es: 'Cómo se conecta esta pestaña a Tor',
          })}
        </p>
        <TorBridgeChoice
          value={bridge}
          onChange={setBridge}
          idPrefix={`receive-anonymous-${mode}-bridge`}
        />
        <p className="text-xs text-muted-foreground">
          {t({
            en: "The sender's choice does not have to match yours: the two only meet inside the Tor network.",
            es: 'La elección del emisor no tiene por qué coincidir con la tuya: los dos solo se encuentran dentro de la red Tor.',
          })}
        </p>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={onCancel} className="flex-1">
          {t({ en: 'Back', es: 'Atrás' })}
        </Button>
        <Button
          onClick={() => onSubmit(bridge)}
          className="flex-1 bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
        >
          <Download className="mr-2 h-4 w-4" />
          {t(CONFIRM_LABELS[mode])}
        </Button>
      </div>
    </div>
  );
}
