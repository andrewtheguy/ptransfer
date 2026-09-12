import { parseOnionAddress } from '@/lib/tor/onion-address';
import { DEFAULT_TOR_BRIDGE, type TorBridge } from '@/lib/tor/bridge';
import type { SelectOption } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { defaultCacheDir } from '../cache-dir';
import { receiveByCode } from '../code/receive';
import { sendByCode } from '../code/send';
import type { TorOptions } from '../tor/bootstrap';
import { destinationFolder } from '../transfer/files';
import { receiveOverTor } from '../transfer/tor-receive';
import { sendOverTor } from '../transfer/tor-send';
import type { Presenter } from '../ui/presenter';
import { Picker } from './picker';
import { type Accepted, ReceiveInputScreen } from './receive-input';
import { Run } from './run';
import { Gap, Note, Problem, Screen } from './screen';
import { type SendChoice, SendMode } from './send-mode';

/**
 * The terminal UI, screen by screen.
 *
 * It runs the same two flows the line interface runs, on the same engine —
 * what it adds is where they are shown and where their questions are answered.
 * The send side mirrors the tab's send tab: pick what to send, then one of the
 * three transfer modes. The receive side mirrors the tab's receive screen:
 * one field, the mode read off what is pasted into it, and then where to save
 * what is coming — that question is always asked, and asked after the code,
 * since until the code is in there is nothing to save.
 *
 * PIN Exchange is in both, and in both it says it is not here yet: it is one
 * of the three modes, and leaving it out would say it had been dropped.
 */

/** A transfer waiting to be started, and what to call its screen. */
interface Running {
  title: string;
  start(presenter: Presenter): Promise<number>;
  firstCode?: string;
}

type Stage =
  | { name: 'home' }
  | { name: 'send-pick' }
  | { name: 'send-mode'; paths: string[] }
  | { name: 'receive-ask' }
  | { name: 'receive-folder'; accepted: Accepted }
  | { name: 'run'; running: Running }
  | { name: 'unsupported'; message: string; back: Stage };

const HOME: SelectOption[] = [
  {
    name: 'Send',
    description: 'Pick files and folders, then how to carry them across',
    value: 'send',
  },
  {
    name: 'Receive',
    description: 'Paste a PIN, a code, or an onion address',
    value: 'receive',
  },
];

/** Tor's defaults, with the bridge the screen before this one chose. */
function torOptionsFor(bridge: TorBridge): TorOptions {
  return { refreshDirectory: false, bridge };
}

export function App({ onExit }: { onExit(status: number): void }) {
  const [stage, setStage] = useState<Stage>({ name: 'home' });
  // Where the folder picker opens: the working directory the first time, and
  // after that wherever the last receive was saved.
  const [folder, setFolder] = useState(process.cwd());
  const [bridge, setBridge] = useState<TorBridge>(DEFAULT_TOR_BRIDGE);

  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') {
      // A running transfer owns circuits, a part file and a peer that is
      // waiting: its own signal handler takes those down and leaves with the
      // status a shell gives an interrupted process. Everywhere else there is
      // nothing to take down.
      if (stage.name === 'run') process.kill(process.pid, 'SIGINT');
      else onExit(130);
    }
  });

  const startSend = (choice: SendChoice) => {
    const torOptions = torOptionsFor(choice.bridge);
    const running: Running =
      choice.mode === 'code'
        ? {
            title: 'Send · Code Exchange',
            start: (presenter) =>
              sendByCode({
                content: choice.content,
                anonymous: choice.anonymous,
                torOptions,
                cacheDir: defaultCacheDir(),
                verbose: false,
                presenter,
              }),
          }
        : {
            title: 'Send · Tor Onion Service',
            start: (presenter) =>
              sendOverTor({
                content: choice.content,
                torOptions,
                verbose: false,
                presenter,
              }),
          };
    setStage({ name: 'run', running });
  };

  // `into` has been through `destinationFolder` — the picker will not hand
  // over a folder that has not — which is the check the line interface does
  // to `--out` before it bootstraps.
  const startReceive = (accepted: Accepted, into: string) => {
    setFolder(into);
    const torOptions = torOptionsFor(bridge);
    if (accepted.kind === 'offer') {
      setStage({
        name: 'run',
        running: {
          title: 'Receive · Code Exchange',
          firstCode: accepted.code,
          start: (presenter) =>
            receiveByCode({
              folder: into,
              simulateNoDirect: false,
              torOptions,
              cacheDir: defaultCacheDir(),
              verbose: false,
              presenter,
            }),
        },
      });
      return;
    }
    // The address came through `classifyReceiveText`, which parses it, so
    // this cannot fail; going back to the field is what it would mean if it
    // did.
    const parsed = parseOnionAddress(accepted.address);
    if (!parsed) {
      setStage({ name: 'receive-ask' });
      return;
    }
    setStage({
      name: 'run',
      running: {
        title: 'Receive · Tor Onion Service',
        start: (presenter) =>
          receiveOverTor({
            parsed,
            folder: into,
            torOptions,
            verbose: false,
            presenter,
          }),
      },
    });
  };

  switch (stage.name) {
    case 'home':
      return (
        <Screen title="Home" hints={['↑↓ choose', 'enter open', 'ctrl-c quit']}>
          <Note>
            Send files and folders, or receive what someone is sending.
          </Note>
          <Gap />
          <box style={{ height: 6 }}>
            <select
              focused
              options={HOME}
              showDescription
              onSelect={(_, option) =>
                setStage(
                  option?.value === 'send'
                    ? { name: 'send-pick' }
                    : { name: 'receive-ask' },
                )
              }
              style={{ flexGrow: 1 }}
            />
          </box>
        </Screen>
      );

    case 'send-pick':
      return (
        <Picker
          mode="paths"
          start={process.cwd()}
          title="Send · what to send"
          onDone={(paths) => setStage({ name: 'send-mode', paths })}
          onCancel={() => setStage({ name: 'home' })}
        />
      );

    case 'send-mode':
      return (
        <SendMode
          paths={stage.paths}
          onStart={startSend}
          onCancel={() => setStage({ name: 'send-pick' })}
        />
      );

    case 'receive-ask':
      return (
        <ReceiveInputScreen
          bridge={bridge}
          onBridge={() =>
            setBridge((was) => (was === 'websocket' ? 'webrtc' : 'websocket'))
          }
          onAccept={(accepted) => setStage({ name: 'receive-folder', accepted })}
          onUnsupported={(message) =>
            setStage({ name: 'unsupported', message, back: stage })
          }
          onCancel={() => setStage({ name: 'home' })}
        />
      );

    case 'receive-folder':
      return (
        <Picker
          mode="folder"
          start={folder}
          title="Receive · where to save"
          accept={destinationFolder}
          onDone={([chosen]) => {
            if (chosen) startReceive(stage.accepted, chosen);
          }}
          onCancel={() => setStage({ name: 'receive-ask' })}
        />
      );

    case 'run':
      return (
        <Run
          title={stage.running.title}
          start={stage.running.start}
          firstCode={stage.running.firstCode}
          onFinished={onExit}
        />
      );

    case 'unsupported':
      return (
        <Unsupported
          message={stage.message}
          onBack={() => setStage(stage.back)}
        />
      );
  }
}

/** A mode that is one of the three, but is not here yet. */
function Unsupported({
  message,
  onBack,
}: {
  message: string;
  onBack(): void;
}) {
  useKeyboard((key) => {
    if (key.name === 'return' || key.name === 'escape') onBack();
  });
  return (
    <Screen title="PIN Exchange" hints={['enter back']}>
      <Problem>{message}</Problem>
      <Gap />
      <Note>
        Code Exchange carries the same transfer; the code is longer than a PIN,
        and it has to be copied rather than read out.
      </Note>
    </Screen>
  );
}
