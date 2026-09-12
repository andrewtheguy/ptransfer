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
 * the tab offers behind these modes are here as keys: what `--anonymous` turns
 * on — the whole handshake through Tor for a PIN, the fallback alone for a
 * code — and the bridge that `--bridge` chooses.
 */

export type SendMode = 'pin' | 'code' | 'tor';

/** Whether a chosen option is one of the three modes, rather than nothing. */
function isSendMode(value: unknown): value is SendMode {
  return value === 'pin' || value === 'code' || value === 'tor';
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
    if (key.name === 'a') change({ anonymous: !settings.current.anonymous });
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
    onStart({ mode: chosen, content: opened.source, ...settings.current });
  };

  const usesTor = mode === 'tor' || anonymous;
  const caution = opened && mode === 'tor' ? torSendCaution(opened.source) : null;

  return (
    <Screen
      title="Send"
      hints={[
        '↑↓ choose',
        'enter start',
        mode === 'pin' ? 'a anonymous signaling' : 'a anonymous fallback',
        'b bridge',
        'esc back',
      ]}
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
            if (isSendMode(option?.value)) setMode(option.value);
          }}
          onSelect={(_, option) => {
            if (isSendMode(option?.value)) start(option.value);
          }}
          style={{ flexGrow: 1 }}
        />
      </box>
      <Gap />
      {mode === 'pin' && (
        <Note>
          {anonymous
            ? 'Anonymous signaling on: the handshake, and a file that finds no direct route, go through Tor.'
            : 'Anonymous signaling off: the handshake goes over public Nostr relays.'}
        </Note>
      )}
      {mode === 'code' && (
        <Note>
          {anonymous
            ? 'Anonymous fallback on: a file that finds no direct route goes through Tor.'
            : 'Anonymous fallback off: a file that finds no direct route goes through public Nostr relays.'}
        </Note>
      )}
      {usesTor && <Note>{`Tor bridge: ${TOR_BRIDGE_LABELS[bridge]}`}</Note>}
      {caution && <Note>{caution}</Note>}
      <Gap />
      {refusal && <Problem>{refusal}</Problem>}
    </Screen>
  );
}
