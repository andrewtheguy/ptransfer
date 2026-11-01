import { formatFileSize } from '@/lib/file-utils';
import { t } from '@/lib/i18n';
import {
  DEFAULT_TOR_BRIDGE,
  TOR_BRIDGE_LABELS,
  type TorBridge,
} from '@/lib/tor/bridge';
import type { SelectOption } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import type { TransferSource } from '@/lib/transfer-source';
import { openSelection, type Selection } from '../transfer/selection';
import { torSendCaution, torSendRefusal } from '../transfer/tor-send';
import { Gap, Note, Problem, Screen } from './screen';
import { theme } from './theme';

/**
 * The send screen's mode choice — the tab's three transfer modes, in the same
 * order and with the same names, so that what a person learns in one place
 * holds in the other.
 *
 * The cursor opens on PIN Exchange, as the tab does. The two advanced options
 * the tab offers behind these modes are rows under the menu, each carrying
 * the key that changes it and a line saying what it does: what `--anonymous`
 * turns on — the whole handshake through Tor for a PIN, the fallback alone
 * for a code — and the bridge that `--bridge` chooses. They are rows rather
 * than key hints because the anonymous option is the one thing here somebody
 * has to decide before starting, and a hint along the bottom is read by
 * somebody who already knows it exists.
 */

export type SendMode = 'pin' | 'code' | 'tor';

/** Whether a chosen option is one of the three modes, rather than nothing. */
function isSendMode(value: unknown): value is SendMode {
  return value === 'pin' || value === 'code' || value === 'tor';
}

/**
 * Whether a mode has an anonymous option at all. The Tor mode is inside Tor
 * from end to end already, so there is nothing there for it to turn on.
 */
function hasAnonymousOption(mode: SendMode): boolean {
  return mode === 'pin' || mode === 'code';
}

/** What the option is called on the row it belongs to, as the tab calls it. */
function anonymousLabel(mode: SendMode): string {
  return mode === 'code'
    ? t({
        en: 'Anonymous signaling and relay (experimental)',
        es: 'Señalización y relay anónimos (experimental)',
      })
    : t({
        en: 'Anonymous signaling (experimental)',
        es: 'Señalización anónima (experimental)',
      });
}

/**
 * What the option does, said the same way in either state: this is the line
 * somebody reads to decide, so it cannot appear only once they have.
 */
function anonymousHint(mode: SendMode): string {
  return mode === 'code'
    ? t({
        en: 'No direct route? Relay the file over Tor instead. Slow; up to 100 MiB.',
        es: '¿Sin ruta directa? El archivo pasa por Tor. Lento; hasta 100 MiB.',
      })
    : t({
        en: 'Signaling over Tor, so relays never see an IP. Slow to start; longer PIN.',
        es: 'Señalización por Tor: los relays nunca ven una IP. Tarda en arrancar; PIN más largo.',
      });
}

export interface SendChoice {
  mode: SendMode;
  content: TransferSource;
  anonymous: boolean;
  bridge: TorBridge;
}

function modeOptions(): SelectOption[] {
  return [
    {
      name: t({ en: 'PIN Exchange', es: 'Intercambio por PIN' }),
      description: t({
        en: 'Read out a short PIN, then compare a confirmation code',
        es: 'Dicta un PIN corto y luego compara un código de confirmación',
      }),
      value: 'pin',
    },
    {
      name: t({ en: 'Code Exchange', es: 'Intercambio por código' }),
      description: t({
        en: 'Carry a code, then a direct connection or a relay fallback',
        es: 'Pasa un código; luego conexión directa o respaldo por relays',
      }),
      value: 'code',
    },
    {
      name: t({ en: 'Tor Onion Service', es: 'Servicio onion de Tor' }),
      description: t({
        en: 'Publish an onion service and carry its address and password',
        es: 'Publica un servicio onion y pasa su dirección y contraseña',
      }),
      value: 'tor',
    },
  ];
}

export function SendMode({
  paths,
  onStart,
  onCancel,
}: {
  paths: string[];
  onStart(choice: SendChoice): void;
  onCancel(): void;
}) {
  const [opened, setOpened] = useState<Selection | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [mode, setMode] = useState<SendMode>('pin');
  const [refusal, setRefusal] = useState<string | null>(null);
  // What the two keys set, read back when a transfer starts. A key and the
  // Enter that starts the transfer can arrive in one terminal read, and state
  // the key changed has not been committed by the time Enter is handled — the
  // transfer would start on the setting the person just turned off. The state
  // beside it is only what the screen draws.
  const settings = useRef<{ anonymous: boolean; bridge: TorBridge }>({
    anonymous: false,
    bridge: DEFAULT_TOR_BRIDGE,
  });
  const [{ anonymous, bridge }, setShown] = useState(settings.current);
  // The highlighted row, for the same reason: an arrow key and the key after
  // it can arrive in one terminal read, and `mode` would still be the row the
  // person has already moved off.
  const highlighted = useRef<SendMode>('pin');

  const change = (next: Partial<typeof settings.current>) => {
    settings.current = { ...settings.current, ...next };
    setShown(settings.current);
  };

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const selection = await openSelection(paths);
        if (current) setOpened(selection);
      } catch (error) {
        if (current) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [paths]);

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
      return;
    }
    // Only where there is a row to see it on: a key that quietly changed a
    // setting the screen is not showing is a setting nobody chose.
    if (key.name === 'a' && hasAnonymousOption(highlighted.current)) {
      change({ anonymous: !settings.current.anonymous });
    }
    if (key.name === 'b') {
      change({
        bridge: settings.current.bridge === 'websocket' ? 'webrtc' : 'websocket',
      });
    }
  });

  const start = (chosen: SendMode) => {
    if (!opened) return;
    if (chosen === 'tor') {
      const no = torSendRefusal(opened.source);
      if (no) {
        setRefusal(no);
        return;
      }
    }
    onStart({
      mode: chosen,
      content: opened.source,
      bridge: settings.current.bridge,
      anonymous: hasAnonymousOption(chosen) && settings.current.anonymous,
    });
  };

  const usesTor = mode === 'tor' || anonymous;
  const caution = opened && mode === 'tor' ? torSendCaution(opened.source) : null;

  return (
    <Screen
      title={t({ en: 'Send', es: 'Enviar' })}
      hints={[
        t({ en: '↑↓ choose', es: '↑↓ elegir' }),
        t({ en: 'enter start', es: 'enter iniciar' }),
        t({ en: 'esc back', es: 'esc atrás' }),
      ]}
    >
      {failure ? (
        <Problem>{failure}</Problem>
      ) : !opened ? (
        <Note>
          {t({
            en: 'Reading what was marked...',
            es: 'Leyendo lo marcado...',
          })}
        </Note>
      ) : (
        <text fg={theme.good}>
          {opened.source.archive
            ? t({
                en: `${opened.fileCount} files · ${formatFileSize(opened.source.estimatedSize)} as ${opened.source.name}`,
                es: `${opened.fileCount} ${opened.fileCount === 1 ? 'archivo' : 'archivos'} · ${formatFileSize(opened.source.estimatedSize)} como ${opened.source.name}`,
              })
            : `${opened.source.name} · ${formatFileSize(opened.source.estimatedSize)}`}
        </text>
      )}
      {opened && opened.skipped.length > 0 && (
        <Note>
          {t({
            en: `Leaving out ${opened.skipped.length} symbolic link or special file, which the ZIP does not carry`,
            es:
              opened.skipped.length === 1
                ? 'Se omite 1 enlace simbólico o archivo especial, que el ZIP no incluye'
                : `Se omiten ${opened.skipped.length} enlaces simbólicos o archivos especiales, que el ZIP no incluye`,
          })}
        </Note>
      )}
      <Gap />
      <box style={{ height: 8 }}>
        <select
          focused
          // The tab's own default.
          selectedIndex={0}
          options={modeOptions()}
          showDescription
          onChange={(_, option) => {
            if (isSendMode(option?.value)) {
              highlighted.current = option.value;
              setMode(option.value);
            }
          }}
          onSelect={(_, option) => {
            if (isSendMode(option?.value)) start(option.value);
          }}
          style={{ flexGrow: 1 }}
        />
      </box>
      <Gap />
      {hasAnonymousOption(mode) && (
        <>
          <text fg={anonymous ? theme.good : theme.heading}>
            {`[${anonymous ? 'x' : ' '}] ${anonymousLabel(mode)}   ${
              anonymous
                ? t({ en: 'a to turn off', es: 'a para desactivar' })
                : t({ en: 'a to turn on', es: 'a para activar' })
            }`}
          </text>
          <Note>{anonymousHint(mode)}</Note>
        </>
      )}
      {usesTor && (
        <text fg={theme.heading}>
          {t({
            en: `Tor bridge: ${TOR_BRIDGE_LABELS[bridge]}   b to change`,
            es: `Puente de Tor: ${TOR_BRIDGE_LABELS[bridge]}   b para cambiar`,
          })}
        </text>
      )}
      {caution && <Note>{caution}</Note>}
      <Gap />
      {refusal && <Problem>{refusal}</Problem>}
    </Screen>
  );
}
