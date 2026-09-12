import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateMutualClipboardData,
  generateMutualOfferBinary,
} from '@/lib/code-signaling';
import { generatePin } from '@/lib/crypto';
import type { TestRendererSetup } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';
import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { act } from 'react';
import { App } from './app';
import { MaskedField } from './masked-field';
import { Picker } from './picker';
import { type Accepted, ReceiveInputScreen } from './receive-input';
import { Run } from './run';
import { SendMode } from './send-mode';

/**
 * The terminal UI's screens, drawn and driven.
 *
 * OpenTUI loads a native Zig core over FFI and needs Bun or a very recent
 * Node, which the vitest unit project does not have, so these run under
 * `bun test` — `bun run test:tui` — and the vitest run leaves `*.tui.test.tsx`
 * alone. What they cover is the UI itself: what a screen draws, and what a
 * keystroke does to it. A transfer's own behaviour is tested through the line
 * interface, which is what the live tests drive.
 */

const ONION = 'zrmxlosp6cvmkhxwhx7267wkvqyztsrmloqw76eu4fhn2gsbg5zk4kad.onion';

/**
 * A Code Exchange code the size a real one is.
 *
 * It carries the SDP and every ICE candidate the sender gathered, so its
 * length follows the host it was made on and has no ceiling in the protocol.
 * The candidates here are distinct, as a real gather's are — a repeated one
 * deflates away and would make the code look far shorter than it is.
 */
function code(candidates: number): string {
  const sdp = `v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:Nx2R\r\na=ice-pwd:gY0Xx3vBqLpZkE8sWtCfRmDn\r\na=fingerprint:sha-256 8D:4A:2F:9C:1B:6E:73:A0:55:CD:12:EF:34:90:7B:26:48:F1:AC:5D:9E:03:B8:61:2C:D7:4F:8A:15:60:E9:3B\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\n`;
  return generateMutualClipboardData(
    generateMutualOfferBinary(
      { type: 'offer', sdp },
      Array.from(
        { length: candidates },
        (_, i) =>
          `candidate:${i} 1 udp ${1677729535 - i * 7} ${10 + i}.${(i * 37) % 251}.${(i * 91) % 253}.${(i * 13) % 249} ${40000 + i * 137} typ srflx raddr 192.168.${i}.${i * 3} rport ${54000 + i} generation 0 ufrag N${i}x2R`,
      ),
      {
        createdAt: Date.now(),
        fileName: 'holiday-photos.zip',
        fileSize: 128 * 1024 * 1024,
        contentEncoding: 'identity',
        mimeType: 'application/zip',
        publicKey: crypto.getRandomValues(new Uint8Array(65)),
        salt: crypto.getRandomValues(new Uint8Array(16)),
        relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://nostr.wine'],
      },
    ),
  );
}

/** Long enough that a bare ESC has been given up on as an escape sequence. */
const ESCAPE_TIMEOUT_MS = 60;

const torn: (() => void)[] = [];

afterEach(() => {
  for (const down of torn.splice(0)) down();
});

interface Screen extends TestRendererSetup {
  /** Let React commit what the last keystroke changed, then draw it. */
  settle(): Promise<void>;
  /** The frame as characters, with its box drawing left in. */
  frame(): string;
}

async function draw(node: ReactNode): Promise<Screen> {
  const setup = await testRender(node, { width: 80, height: 24 });
  torn.push(() => setup.renderer.destroy());
  // `flush` draws what React has already committed, and a keystroke's state
  // change is committed on a later task; `act` is what runs that task and the
  // effects behind it, which is how `testRender` means to be driven. The wait
  // is long enough for the input parser's escape timeout: a lone ESC could
  // still be the start of an arrow key, so it is held until it is not.
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT_MS));
    });
    await setup.flush();
  };
  await settle();
  return { ...setup, settle, frame: setup.captureCharFrame };
}

/** A directory holding one folder and two files, for the picker to list. */
async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ptransfer-tui-'));
  await mkdir(join(root, 'photos'));
  await writeFile(join(root, 'notes.txt'), 'hello');
  await writeFile(join(root, 'report.pdf'), 'x'.repeat(2048));
  return root;
}

describe('the path picker', () => {
  it('lists a folder before its files, each with a box to mark', async () => {
    const root = await tree();
    const screen = await draw(
      <Picker
        mode="paths"
        start={root}
        title="Send"
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = screen.frame();
    expect(frame.indexOf('photos/')).toBeLessThan(frame.indexOf('notes.txt'));
    expect(frame).toContain('[ ] photos/');
    expect(frame).toContain('2.0 KiB');
    expect(frame).toContain('Nothing marked yet');
  });

  it('marks what the cursor is on and hands the marked paths over', async () => {
    const root = await tree();
    const chosen: string[][] = [];
    const screen = await draw(
      <Picker
        mode="paths"
        start={root}
        title="Send"
        onDone={(paths) => chosen.push(paths)}
        onCancel={() => {}}
      />,
    );
    // Down twice: past `../` and `photos/`, onto `notes.txt`. Keys arriving
    // in one batch is the point — the cursor must not be read off the frame
    // they landed in.
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressKey(' ');
    await screen.settle();
    expect(screen.frame()).toContain('[x] notes.txt');
    expect(screen.frame()).toContain('1 marked');
    screen.mockInput.pressTab();
    await screen.settle();
    expect(chosen).toEqual([[join(root, 'notes.txt')]]);
  });

  it('walks into a folder and marks what is inside it', async () => {
    const root = await tree();
    await writeFile(join(root, 'photos', 'one.jpg'), 'jpg');
    const chosen: string[][] = [];
    const screen = await draw(
      <Picker
        mode="paths"
        start={root}
        title="Send"
        onDone={(paths) => chosen.push(paths)}
        onCancel={() => {}}
      />,
    );
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressArrow('right');
    await screen.settle();
    expect(screen.frame()).toContain('one.jpg');
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressKey(' ');
    await screen.settle();
    screen.mockInput.pressTab();
    await screen.settle();
    expect(chosen).toEqual([[join(root, 'photos', 'one.jpg')]]);
  });

  it('takes the folder it is browsing when it is picking one', async () => {
    const root = await tree();
    const chosen: string[][] = [];
    const screen = await draw(
      <Picker
        mode="folder"
        start={root}
        title="Receive"
        onDone={(paths) => chosen.push(paths)}
        onCancel={() => {}}
      />,
    );
    expect(screen.frame()).toContain('enter use this folder');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(chosen).toEqual([[root]]);
  });
});

describe('the send mode screen', () => {
  it('offers the tab’s three modes and summarizes what was marked', async () => {
    const root = await tree();
    const screen = await draw(
      <SendMode
        paths={[join(root, 'notes.txt')]}
        onStart={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = screen.frame();
    expect(frame).toContain('notes.txt · 5 B');
    expect(frame).toContain('PIN Exchange');
    expect(frame).toContain('Code Exchange');
    expect(frame).toContain('Tor Onion Service');
  });

  it('says PIN Exchange is not here yet rather than starting it', async () => {
    const root = await tree();
    const started: unknown[] = [];
    const screen = await draw(
      <SendMode
        paths={[join(root, 'notes.txt')]}
        onStart={(choice) => started.push(choice)}
        onCancel={() => {}}
      />,
    );
    screen.mockInput.pressArrow('up');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(screen.frame()).toContain('not supported in the terminal yet');
    expect(started).toEqual([]);
  });

  it('starts Code Exchange with the anonymous fallback the a key turns on', async () => {
    const root = await tree();
    const started: { mode: string; anonymous: boolean }[] = [];
    const screen = await draw(
      <SendMode
        paths={[join(root, 'notes.txt')]}
        onStart={(choice) =>
          started.push({ mode: choice.mode, anonymous: choice.anonymous })
        }
        onCancel={() => {}}
      />,
    );
    expect(screen.frame()).toContain('Anonymous fallback off');
    screen.mockInput.pressKey('a');
    await screen.settle();
    expect(screen.frame()).toContain('Anonymous fallback on');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(started).toEqual([{ mode: 'code', anonymous: true }]);
  });

  it('starts on the setting the key changed, even in one batch with enter', async () => {
    const root = await tree();
    const started: { anonymous: boolean; bridge: string }[] = [];
    const screen = await draw(
      <SendMode
        paths={[join(root, 'notes.txt')]}
        onStart={(choice) =>
          started.push({ anonymous: choice.anonymous, bridge: choice.bridge })
        }
        onCancel={() => {}}
      />,
    );
    // No settle between them: both keys are handled before React has
    // committed anything the first one changed.
    screen.mockInput.pressKey('a');
    screen.mockInput.pressKey('b');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(started).toEqual([{ anonymous: true, bridge: 'webrtc' }]);
  });
});

describe('the masked field', () => {
  it('submits what was typed, even when enter lands in the same batch', async () => {
    const given: string[] = [];
    const screen = await draw(<MaskedField onSubmit={(v) => given.push(v)} />);
    screen.mockInput.pressKey('a');
    screen.mockInput.pressKey('b');
    screen.mockInput.pressKey('c');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(given).toEqual(['abc']);
  });

  it('submits a pasted password without a frame drawn in between', async () => {
    const given: string[] = [];
    const screen = await draw(<MaskedField onSubmit={(v) => given.push(v)} />);
    await screen.mockInput.pasteBracketedText('ABCD-EFGH-JKLM');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(given).toEqual(['ABCD-EFGH-JKLM']);
  });

  it('draws a dot per character and never the password', async () => {
    const screen = await draw(<MaskedField onSubmit={() => {}} />);
    await screen.mockInput.pasteBracketedText('secret');
    await screen.settle();
    expect(screen.frame()).toContain('••••••');
    expect(screen.frame()).not.toContain('secret');
  });
});

describe('the receive screen', () => {
  it('reads an onion address off what was pasted', async () => {
    const accepted: unknown[] = [];
    const screen = await draw(
      <ReceiveInputScreen
        folder="/tmp"
        folderProblem={null}
        bridge="websocket"
        onFolder={() => {}}
        onBridge={() => {}}
        onAccept={(what) => accepted.push(what)}
        onUnsupported={() => {}}
        onCancel={() => {}}
      />,
    );
    await screen.mockInput.pasteBracketedText(ONION);
    await screen.settle();
    expect(screen.frame()).toContain('A Tor onion service');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(accepted).toEqual([{ kind: 'onion', address: ONION }]);
  });

  it('recognizes a PIN and says PIN Exchange is not here yet', async () => {
    const refusals: string[] = [];
    const screen = await draw(
      <ReceiveInputScreen
        folder="/tmp"
        folderProblem={null}
        bridge="websocket"
        onFolder={() => {}}
        onBridge={() => {}}
        onAccept={() => {}}
        onUnsupported={(message) => refusals.push(message)}
        onCancel={() => {}}
      />,
    );
    await screen.mockInput.pasteBracketedText(generatePin());
    await screen.settle();
    expect(screen.frame()).toContain('A PIN Exchange PIN');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('not supported in the terminal yet');
  });

  it('refuses text that is none of the three', async () => {
    const screen = await draw(
      <ReceiveInputScreen
        folder="/tmp"
        folderProblem={null}
        bridge="websocket"
        onFolder={() => {}}
        onBridge={() => {}}
        onAccept={() => {}}
        onUnsupported={() => {}}
        onCancel={() => {}}
      />,
    );
    // Enter in the same batch as the paste: the field has the text before any
    // frame has been drawn with it, and submitting must read that, not the
    // state left over from the frame before.
    await screen.mockInput.pasteBracketedText('good morning');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(screen.frame()).toContain('not a PIN, a code, or an onion address');
  });

  it('opens the folder picker on tab, even with the field focused', async () => {
    let asked = 0;
    const screen = await draw(
      <ReceiveInputScreen
        folder="/tmp"
        folderProblem={null}
        bridge="websocket"
        onFolder={() => {
          asked += 1;
        }}
        onBridge={() => {}}
        onAccept={() => {}}
        onUnsupported={() => {}}
        onCancel={() => {}}
      />,
    );
    screen.mockInput.pressTab();
    await screen.settle();
    expect(asked).toBe(1);
  });

  it('says where the file will be saved', async () => {
    const screen = await draw(
      <ReceiveInputScreen
        folder="/tmp/somewhere"
        folderProblem={null}
        bridge="websocket"
        onFolder={() => {}}
        onBridge={() => {}}
        onAccept={() => {}}
        onUnsupported={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.frame()).toContain('Saving into /tmp/somewhere');
  });

  it('takes a whole code, however far past a field’s own cap it runs', async () => {
    const taken: Accepted[] = [];
    const whole = code(16);
    // Past the thousand characters OpenTUI's own input stops at, which it
    // drops the rest of a paste for without saying anything.
    expect(whole.length).toBeGreaterThan(1000);
    const screen = await draw(
      <ReceiveInputScreen
        folder="/tmp"
        folderProblem={null}
        bridge="websocket"
        onFolder={() => {}}
        onBridge={() => {}}
        onAccept={(what) => taken.push(what)}
        onUnsupported={() => {}}
        onCancel={() => {}}
      />,
    );
    await screen.mockInput.pasteBracketedText(whole);
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(taken).toEqual([{ kind: 'offer', code: whole }]);
  });

  it('says a code arrived in part rather than calling it no code at all', async () => {
    const taken: Accepted[] = [];
    const screen = await draw(
      <ReceiveInputScreen
        folder="/tmp"
        folderProblem={null}
        bridge="websocket"
        onFolder={() => {}}
        onBridge={() => {}}
        onAccept={(what) => taken.push(what)}
        onUnsupported={() => {}}
        onCancel={() => {}}
      />,
    );
    // The PT01 header survives a cut, so this is what a code looks like when
    // something along the way stopped carrying it.
    await screen.mockInput.pasteBracketedText(code(16).slice(0, 1000));
    await screen.settle();
    expect(screen.frame()).toContain('not a whole one');
    expect(screen.frame()).not.toContain('A Code Exchange code');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(taken).toEqual([]);
  });

  it('names the Tor bridge and turns it over on shift-tab', async () => {
    const bridges: string[] = [];
    const screen = await draw(
      <ReceiveInputScreen
        folder="/tmp"
        folderProblem={null}
        bridge="webrtc"
        onFolder={() => {}}
        onBridge={() => bridges.push('turned')}
        onAccept={() => {}}
        onUnsupported={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.frame()).toContain('Tor bridge: Snowflake WebRTC');
    screen.mockInput.pressTab({ shift: true });
    await screen.settle();
    expect(bridges).toEqual(['turned']);
  });

  it('refuses to start anything while the folder cannot be saved into', async () => {
    const accepted: unknown[] = [];
    const screen = await draw(
      <ReceiveInputScreen
        folder="/tmp/locked"
        folderProblem="Cannot save files in /tmp/locked"
        bridge="websocket"
        onFolder={() => {}}
        onBridge={() => {}}
        onAccept={(what) => accepted.push(what)}
        onUnsupported={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.frame()).toContain('Cannot save files in /tmp/locked');
    await screen.mockInput.pasteBracketedText(ONION);
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(accepted).toEqual([]);
  });
});

describe('the app', () => {
  it('opens on the choice between sending and receiving', async () => {
    const screen = await draw(<App onExit={() => {}} />);
    const frame = screen.frame();
    expect(frame).toContain('Send');
    expect(frame).toContain('Receive');
    expect(frame).toContain('Paste a PIN, a code, or an onion address');
  });

  it('goes from the home screen into the path picker and back', async () => {
    const screen = await draw(<App onExit={() => {}} />);
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(screen.frame()).toContain('space mark');
    screen.mockInput.pressEscape();
    await screen.settle();
    expect(screen.frame()).toContain('Send files and folders');
  });

  it('goes from the home screen into the receive field', async () => {
    const screen = await draw(<App onExit={() => {}} />);
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(screen.frame()).toContain('Paste what the sender gave you');
  });

  it('says so when the folder it opened in cannot be saved into', async () => {
    const root = await tree();
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);
    const was = process.cwd();
    process.chdir(locked);
    try {
      const screen = await draw(<App onExit={() => {}} />);
      screen.mockInput.pressArrow('down');
      screen.mockInput.pressEnter();
      await screen.settle();
      expect(screen.frame()).toContain('Cannot save files in');
    } finally {
      process.chdir(was);
      await chmod(locked, 0o700);
    }
  });

  it('leaves with the status a shell gives an interrupted process', async () => {
    const left: number[] = [];
    const screen = await draw(<App onExit={(status) => left.push(status)} />);
    screen.mockInput.pressCtrlC();
    await screen.settle();
    expect(left).toEqual([130]);
  });
});

describe('the run screen', () => {
  it('shows a long code in a box of its own, takes a response, and ends', async () => {
    const code = 'PT01'.repeat(300);
    let answered: string | null = null;
    const screen = await draw(
      <Run
        title="Send · Code Exchange"
        start={async (presenter) => {
          presenter.say('Give the receiver this code:');
          presenter.hand(code);
          presenter.status('Checking relays for the fallback...');
          answered = await presenter.readCode(
            "Paste the receiver's response: ",
            async (container) => new TextDecoder().decode(container),
          );
          presenter.progress(50, 100);
          presenter.say('Sent notes.txt');
          return 0;
        }}
        onFinished={() => {}}
      />,
    );
    const frame = screen.frame();
    expect(frame).toContain('Give the receiver this code:');
    expect(frame).toContain(`code · ${code.length} characters`);
    expect(frame).toContain('Press tab to copy it to the clipboard');
    expect(frame).toContain('Checking relays for the fallback');
    expect(frame).toContain("Paste the receiver's response");
    // The code is far longer than the screen, so only its start is on it.
    expect(frame).toContain('PT01PT01');
    expect(answered).toBeNull();
  });

  it('says why a code was refused and asks for it again', async () => {
    const screen = await draw(
      <Run
        title="Receive · Code Exchange"
        start={async (presenter) => {
          await presenter.readCode('Paste the code: ', async () => 'taken');
          return 0;
        }}
        onFinished={() => {}}
      />,
    );
    await screen.mockInput.pasteBracketedText('not-a-code');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(screen.frame()).toContain('not a complete pTransfer code');
    expect(screen.frame()).toContain('Paste the code');
  });

  it('stays up with what went wrong and leaves with a failure', async () => {
    const left: number[] = [];
    const screen = await draw(
      <Run
        title="Send · Tor Onion Service"
        start={async () => {
          throw new Error('The circuit would not open');
        }}
        onFinished={(status) => left.push(status)}
      />,
    );
    expect(screen.frame()).toContain('The circuit would not open');
    expect(screen.frame()).toContain('enter quit');
    screen.mockInput.pressEnter();
    await screen.settle();
    expect(left).toEqual([1]);
  });

  it('hands over a Tor address and password under a key each', async () => {
    const screen = await draw(
      <Run
        title="Send · Tor Onion Service"
        start={async (presenter) => {
          presenter.hand(`${ONION}`, 'address');
          presenter.hand('ABCD-EFGH-JKLM', 'password');
          return await new Promise<number>(() => {});
        }}
        onFinished={() => {}}
      />,
    );
    const frame = screen.frame();
    expect(frame).toContain('1. address:');
    expect(frame).toContain('2. password: ABCD-EFGH-JKLM');
    expect(frame).toContain('Press 1 or 2 to copy');
  });

  it('takes a whole response, however far past a field’s own cap it runs', async () => {
    const whole = code(16);
    let answered: string | null = null;
    const screen = await draw(
      <Run
        title="Send · Code Exchange"
        start={async (presenter) => {
          answered = await presenter.readCode(
            "Paste the receiver's response: ",
            async (container) => String(container.length),
          );
          return 0;
        }}
        onFinished={() => {}}
      />,
    );
    await screen.mockInput.pasteBracketedText(whole);
    screen.mockInput.pressEnter();
    await screen.settle();
    // A code cut short does not decode, and the screen would be asking again.
    expect(screen.frame()).not.toContain('not a complete pTransfer code');
    expect(answered).not.toBeNull();
  });

  it('copies on tab while the field for the answer has the keyboard', async () => {
    const screen = await draw(
      <Run
        title="Send · Code Exchange"
        start={async (presenter) => {
          presenter.hand('PT01'.repeat(300));
          return await presenter.readCode('Paste it: ', async () => 0);
        }}
        onFinished={() => {}}
      />,
    );
    expect(screen.frame()).toContain('Press tab to copy it to the clipboard');
    screen.mockInput.pressTab();
    await screen.settle();
    // The hint is replaced by what the copy did, whichever way it went.
    expect(screen.frame()).not.toContain('Press tab to copy');
  });
});
