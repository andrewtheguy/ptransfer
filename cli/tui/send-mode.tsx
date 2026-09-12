import { formatFileSize } from '@/lib/file-utils';
import { TOR_BRIDGE_LABELS, type TorBridge } from '@/lib/tor/bridge';
import type { SelectOption } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useState } from 'react';
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
 * PIN Exchange is listed because it is one of the three, not because the
 * terminal can run it yet; choosing it says so. The two advanced options the
 * tab offers behind these modes are here as keys: the anonymous fallback that
 * `--anonymous` turns on, and the bridge that `--bridge` chooses.
 */

export type SendMode = 'pin' | 'code' | 'tor';

/** Whether a chosen option is one of the three modes, rather than nothing. */
function isSendMode(value: unknown): value is SendMode {
  return value === 'pin' || value === 'code' || value === 'tor';
}

export interface SendChoice {
  mode: 'code' | 'tor';
  content: TransferSource;
  anonymous: boolean;
  bridge: TorBridge;
}

const OPTIONS: SelectOption[] = [
  {
    name: 'PIN Exchange',
    description: 'Carry a short PIN — not supported in the terminal yet',
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
  const [mode, setMode] = useState<SendMode>('code');
  const [anonymous, setAnonymous] = useState(false);
  const [bridge, setBridge] = useState<TorBridge>('websocket');
  const [refusal, setRefusal] = useState<string | null>(null);

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
    if (key.name === 'a') setAnonymous((was) => !was);
    if (key.name === 'b') {
      setBridge((was) => (was === 'websocket' ? 'webrtc' : 'websocket'));
    }
  });

  const start = (chosen: SendMode) => {
    if (chosen === 'pin') {
      setRefusal(
        'PIN Exchange is not supported in the terminal yet. Use Code Exchange, or run PIN Exchange in the web app.',
      );
      return;
    }
    if (!opened) return;
    if (chosen === 'tor') {
      const no = torSendRefusal(opened.source);
      if (no) {
        setRefusal(no);
        return;
      }
    }
    onStart({ mode: chosen, content: opened.source, anonymous, bridge });
  };

  const usesTor = mode === 'tor' || (mode === 'code' && anonymous);
  const caution = opened && mode === 'tor' ? torSendCaution(opened.source) : null;

  return (
    <Screen
      title="Send"
      hints={['↑↓ choose', 'enter start', 'a anonymous fallback', 'b bridge', 'esc back']}
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
          // Code Exchange, not the PIN Exchange listed above it: the cursor
          // opens on the mode a terminal can actually run.
          selectedIndex={1}
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
