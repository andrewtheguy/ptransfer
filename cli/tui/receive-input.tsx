import { isAnonymousOffer, parseMutualPayload } from '@/lib/code-signaling';
import { t, type Localized } from '@/lib/i18n';
import {
  classifyReceiveText,
  looksLikeOffer,
  looksLikeOnionAddress,
  looksLikePin,
  type ReceiveInput,
} from '@/lib/receive-input';
import { TOR_BRIDGE_LABELS, type TorBridge } from '@/lib/tor/bridge';
import type { SubmitEvent } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { FIELD_MAX, Gap, Note, Problem, Screen } from './screen';
import { theme } from './theme';

/**
 * The receive screen: one field, and the mode read off what is in it.
 *
 * The receiver always holds exactly one of three things — a PIN, a Code
 * Exchange offer, or an onion address — and which it is, is decidable, so
 * there is nothing to ask. This is the tab's own `classifyReceiveText` on the
 * tab's own rules; only the QR chunk form has no answer here, because a
 * terminal has no camera to have scanned one with.
 *
 * Which bridge a Tor receive enters the network through is a row under the
 * field, carrying its own key, as the send screen's settings do — a
 * non-printing key, since the field has every printable one. It is shown only
 * for what will go through Tor, since to anything else the bridge is a
 * setting with nothing to set, and it comes with the line saying what Tor
 * covers for what was pasted: a bootstrap costs minutes, and that is the
 * question somebody is answering when they decide to spend them. Where the
 * file is saved is not a setting here either: it is the screen after this
 * one, asked for once there is something to save.
 */

/**
 * A code that starts right and ends wrong. Worth its own words: a code is
 * carried by hand between two machines, and the way one fails is almost
 * always that something along the way cut it.
 */
const INCOMPLETE: Localized = {
  en: 'That is the start of a code, but not a whole one — or it is more than an hour old. Copy it again, whole.',
  es: 'Eso es el comienzo de un código, pero no uno completo, o tiene más de una hora. Cópialo de nuevo, entero.',
};

export type Accepted =
  | { kind: 'pin'; pin: string; anonymous: boolean }
  | { kind: 'offer'; code: string }
  | { kind: 'onion'; address: string };

/**
 * Whether what is in the field will go through Tor. An onion address always
 * does. A PIN does when it is an anonymous one, which its length says. A code
 * does only when the sender chose the anonymous fallback, which the code says
 * itself — a plain one falls back through Nostr, or not at all, and never
 * starts Tor.
 */
function needsTor(found: ReceiveInput | null): boolean {
  if (found?.kind === 'onion') return true;
  if (found?.kind === 'pin') return found.pinKind === 'anonymous';
  if (found?.kind !== 'offer') return false;
  const payload = parseMutualPayload(found.payload);
  return payload !== null && isAnonymousOffer(payload);
}

/**
 * What Tor covers for what is in the field. The three differ, and saying so
 * wrongly would be worse than saying nothing: a PIN's handshake goes through
 * Tor and its file does not, a code's file does and only when no direct route
 * opens, and an onion address is Tor from end to end.
 */
function torHint(found: ReceiveInput | null): string {
  if (found?.kind === 'pin') {
    return t({
      en: 'Signaling over Tor, so relays never see an IP. Slow to start.',
      es: 'Señalización por Tor: los relays nunca ven una IP. Tarda en arrancar.',
    });
  }
  if (found?.kind === 'offer') {
    return t({
      en: 'No direct route? The file comes over Tor instead. Slow; up to 100 MiB.',
      es: '¿Sin ruta directa? El archivo llega por Tor. Lento; hasta 100 MiB.',
    });
  }
  return t({
    en: "The file comes over Tor, from the sender's onion service. Slow to start.",
    es: 'El archivo llega por Tor, desde el servicio onion del emisor. Tarda en arrancar.',
  });
}

function describe(text: string, found: ReceiveInput | null): string | null {
  if (!text.trim()) return null;
  if (found?.kind === 'pin') {
    return found.pinKind === 'anonymous'
      ? t({
          en: 'A PIN Exchange PIN · anonymous, so its handshake is over Tor',
          es: 'Un PIN de Intercambio por PIN · anónimo: su negociación va por Tor',
        })
      : t({ en: 'A PIN Exchange PIN', es: 'Un PIN de Intercambio por PIN' });
  }
  if (found?.kind === 'offer') {
    return needsTor(found)
      ? t({
          en: 'A Code Exchange code · anonymous, so its fallback is over Tor',
          es: 'Un código de Intercambio por código · anónimo: su respaldo va por Tor',
        })
      : t({
          en: 'A Code Exchange code',
          es: 'Un código de Intercambio por código',
        });
  }
  if (found?.kind === 'onion') {
    return t({
      en: `A Tor onion service · ${found.address}`,
      es: `Un servicio onion de Tor · ${found.address}`,
    });
  }
  if (found?.kind === 'offer-chunk') {
    return t({
      en: 'One QR chunk of a code — a terminal cannot scan the rest',
      es: 'Un fragmento QR de un código: una terminal no puede escanear el resto',
    });
  }
  if (looksLikePin(text)) {
    return t({
      en: 'That looks like a PIN, but it does not check out',
      es: 'Parece un PIN, pero no es válido',
    });
  }
  if (looksLikeOnionAddress(text)) {
    return t({
      en: 'That looks like an onion address, but it does not check out',
      es: 'Parece una dirección onion, pero no es válida',
    });
  }
  if (looksLikeOffer(text)) return t(INCOMPLETE);
  return null;
}

export function ReceiveInputScreen({
  bridge,
  onBridge,
  onAccept,
  onCancel,
}: {
  bridge: TorBridge;
  onBridge(): void;
  onAccept(accepted: Accepted): void;
  onCancel(): void;
}) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const found = classifyReceiveText(text);
  const reading = describe(text, found);
  const tor = needsTor(found);

  // The submitted value rather than the state behind it: a paste and the Enter
  // after it can land in one frame, and the state would still be empty.
  const take = (raw: string) => {
    const found = classifyReceiveText(raw);
    if (!found) {
      setProblem(
        !raw.trim()
          ? t({
              en: 'Paste what the sender gave you.',
              es: 'Pega lo que te dio el emisor.',
            })
          : looksLikeOffer(raw)
            ? t(INCOMPLETE)
            : t({
                en: 'That is not a PIN, a code, or an onion address. Check it was copied whole.',
                es: 'Eso no es un PIN, un código ni una dirección onion. Comprueba que se copió entero.',
              }),
      );
      return;
    }
    setProblem(null);
    switch (found.kind) {
      case 'pin':
        onAccept({
          kind: 'pin',
          pin: found.pin,
          anonymous: found.pinKind === 'anonymous',
        });
        return;
      case 'offer-chunk':
        setProblem(
          t({
            en: 'That is one QR chunk of a code. Ask the sender to copy the whole code as text.',
            es: 'Eso es un fragmento QR de un código. Pide al emisor que copie el código entero como texto.',
          }),
        );
        return;
      case 'offer':
        onAccept({ kind: 'offer', code: raw.trim() });
        return;
      case 'onion':
        onAccept({ kind: 'onion', address: found.address });
        return;
    }
  };

  useKeyboard((key) => {
    if (key.name === 'escape') onCancel();
    if (key.name === 'tab' && tor) onBridge();
  });

  return (
    <Screen
      title={t({ en: 'Receive', es: 'Recibir' })}
      hints={[
        t({ en: 'enter continue', es: 'enter continuar' }),
        t({ en: 'esc back', es: 'esc atrás' }),
      ]}
    >
      <text fg={theme.heading}>
        {t({
          en: 'Paste what the sender gave you',
          es: 'Pega lo que te dio el emisor',
        })}
      </text>
      <Note>
        {t({
          en: 'A PIN, a Code Exchange code, or a .onion address.',
          es: 'Un PIN, un código de Intercambio por código o una dirección .onion.',
        })}
      </Note>
      <Note>
        {t({
          en: 'Where it is saved is the next screen.',
          es: 'Dónde se guarda se elige en la siguiente pantalla.',
        })}
      </Note>
      <Gap />
      <box
        style={{ border: true, borderColor: theme.border, height: 3 }}
        title={t({ en: ' code ', es: ' código ' })}
      >
        <input
          focused
          maxLength={FIELD_MAX}
          placeholder={t({ en: 'paste here', es: 'pega aquí' })}
          onInput={(value) => {
            setText(value);
            setProblem(null);
          }}
          // An input's `onSubmit` is its Enter event, which carries the value;
          // the prop is typed for the textarea's empty event as well, so the
          // handler has to be written to take either.
          onSubmit={(value: string | SubmitEvent) => {
            if (typeof value === 'string') take(value);
          }}
        />
      </box>
      <Gap />
      {reading && <text fg={theme.good}>{reading}</text>}
      {problem && <Problem>{problem}</Problem>}
      <Gap />
      {tor && (
        <>
          <Note>{torHint(found)}</Note>
          <text fg={theme.heading}>
            {t({
              en: `Tor bridge: ${TOR_BRIDGE_LABELS[bridge]}   tab to change`,
              es: `Puente de Tor: ${TOR_BRIDGE_LABELS[bridge]}   tab para cambiar`,
            })}
          </text>
        </>
      )}
    </Screen>
  );
}
