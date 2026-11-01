import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useT } from '@/i18n/locale-context';
import type { Localized } from '@/lib/i18n';
import {
  TOR_BRIDGE_LABELS,
  TOR_BRIDGES,
  type TorBridge,
} from '@/lib/tor/bridge';

/**
 * The one question a tab that is about to reach the Tor network has to ask:
 * which Snowflake bridge it goes through.
 *
 * The Tor transfer mode and the anonymous options in PIN Exchange and Code
 * Exchange put this to the user on both the send and receive side. The
 * trade-off is the same every time, so the wording lives here once rather
 * than in six places that would drift apart.
 */

const BRIDGE_DESCRIPTIONS: Record<TorBridge, Localized> = {
  websocket: {
    en: 'one fixed bridge endpoint, no broker and no STUN. The faster of the two, and the one to try first.',
    es: 'un único punto de acceso fijo, sin intermediario y sin STUN. El más rápido de los dos, y el primero que conviene probar.',
  },
  webrtc: {
    en: 'a volunteer proxy brokered over HTTPS, using STUN. Harder to block, and worth switching to if the WebSocket bridge cannot be reached.',
    es: 'un proxy voluntario asignado por un intermediario a través de HTTPS, usando STUN. Más difícil de bloquear; vale la pena cambiar a este si no se puede alcanzar el puente WebSocket.',
  },
};

interface TorBridgeChoiceProps {
  value: TorBridge;
  onChange: (bridge: TorBridge) => void;
  /**
   * Distinguishes the radio inputs' ids, since a send tab can hold two of
   * these and a page must never repeat one.
   */
  idPrefix: string;
}

export function TorBridgeChoice({
  value,
  onChange,
  idPrefix,
}: TorBridgeChoiceProps) {
  const t = useT();
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as TorBridge)}
      className="gap-2"
    >
      {TOR_BRIDGES.map((bridge) => (
        <label
          key={bridge}
          htmlFor={`${idPrefix}-${bridge}`}
          className="flex cursor-pointer items-start gap-3 text-xs"
        >
          <RadioGroupItem
            id={`${idPrefix}-${bridge}`}
            value={bridge}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">{TOR_BRIDGE_LABELS[bridge]}</span>{' '}
            <span className="text-muted-foreground">
              &mdash; {t(BRIDGE_DESCRIPTIONS[bridge])}
            </span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}
