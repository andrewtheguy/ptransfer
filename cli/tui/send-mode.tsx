import { formatFileSize } from '@/lib/file-utils';
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
    ? 'Anonymous signaling and relay (experimental)'
    : 'Anonymous signaling (experimental)';
}

/**
 * What the option does, said the same way in either state: this is the line
 * somebody reads to decide, so it cannot appear only once they have.
 */
function anonymousHint(mode: SendMode): string {
  return mode === 'code'
    ? 'No direct route? Relay the file over Tor instead. Slow; up to 100 MiB.'
    : 'Signaling over Tor, so relays never see an IP. Slow to start; longer PIN.';
}

export interface SendChoice {
  mode: SendMode;
  content: TransferSource;
  anonymous: boolean;
  bridge: TorBridge;
}

const OPTIONS: SelectOption[] = [
  {
    name: 'PIN Exchange',
    description: 'Read out a short PIN, then compare a confirmation code',
    value: 'pin',
  },
  {
    name: 'Code Exchange',
    description: 'Carry a code, then a direct connection or a relay fallback',
    value: 'code',
  },
  {
    name: 'Tor Onion Service',
    description: 'Publish an onion service and carry its address and password',
    value: 'tor',
  },
];

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
      title="Send"
      hints={['↑↓ choose', 'enter start', 'esc back']}
    >
      {failure ? (
        <Problem>{failure}</Problem>
      ) : !opened ? (
        <Note>Reading what was marked...</Note>
      ) : (
        <text fg={theme.good}>
          {opened.source.precompressed
            ? `${opened.fileCount} files · ${formatFileSize(opened.source.estimatedSize)} as ${opened.source.name}`
            : `${opened.source.name} · ${formatFileSize(opened.source.estimatedSize)}`}
        </text>
      )}
      {opened && opened.skipped.length > 0 && (
        <Note>
          {`Leaving out ${opened.skipped.length} symbolic link or special file, which the ZIP does not carry`}
        </Note>
      )}
      <Gap />
      <box style={{ height: 8 }}>
        <select
          focused
          // The tab's own default.
          selectedIndex={0}
          options={OPTIONS}
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
            {`[${anonymous ? 'x' : ' '}] ${anonymousLabel(mode)}   a to turn ${anonymous ? 'off' : 'on'}`}
          </text>
          <Note>{anonymousHint(mode)}</Note>
        </>
      )}
      {usesTor && (
        <text fg={theme.heading}>
          {`Tor bridge: ${TOR_BRIDGE_LABELS[bridge]}   b to change`}
        </text>
      )}
      {caution && <Note>{caution}</Note>}
      <Gap />
      {refusal && <Problem>{refusal}</Problem>}
    </Screen>
  );
}
