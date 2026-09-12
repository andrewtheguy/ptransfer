#!/usr/bin/env bun

// Live PIN Exchange CLI-to-CLI test: one `ptransfer send --pin` process and
// one `ptransfer receive --pin` process, the sender's PIN piped into the
// receiver and the receiver's confirmation code piped back, the way two people
// at two terminals would carry them — one read out, one read back.
//
//   bun run test:live:pin:cli
//
// Scenarios, in order:
//   direct     a single file over a direct WebRTC connection
//   folder     a folder and a file, which arrive as one ZIP in --out
//   relay      a file with the receiver simulating no direct route, so it
//              goes through the public Nostr relays the sender's offer names
//   anonymous  the same through Tor: an anonymous PIN, so the handshake rides
//              onion relays and the file an onion service; a Tor bootstrap on
//              both sides, so slow, and not run unless asked for
//
// Environment:
//   SCENARIOS   comma-separated scenarios to run (default direct,folder,relay)
//   BRIDGE      the Snowflake bridge the anonymous scenario reaches Tor
//               through, websocket (default) or webrtc
//   TIMEOUT_MS  how long each transfer may take (default 480000)
//   VERBOSE     set to 1 to run both processes with --verbose

import { type ChildProcess, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import {
  assertSameBytes,
  terminate,
  WEB_ROOT,
  withTimeout,
} from './support/live-harness.ts';

const KNOWN_SCENARIOS = ['direct', 'folder', 'relay', 'anonymous'];
const SCENARIOS = new Set(
  (process.env.SCENARIOS ?? 'direct,folder,relay')
    .split(',')
    .map((s) => s.trim()),
);
// A typo or an empty list would otherwise run nothing and report a pass.
const unknown = [...SCENARIOS].filter((s) => !KNOWN_SCENARIOS.includes(s));
if (unknown.length > 0 || SCENARIOS.size === 0) {
  throw new Error(
    `SCENARIOS must name at least one of ${KNOWN_SCENARIOS.join(', ')}` +
      (unknown.length > 0
        ? `; unknown: ${unknown.map((s) => JSON.stringify(s)).join(', ')}`
        : ''),
  );
}
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 8 * 60_000);
const BRIDGE = process.env.BRIDGE ?? 'websocket';
const VERBOSE = process.env.VERBOSE === '1' ? ['--verbose'] : [];

// Through realpath: on macOS the temporary directory is reached through a
// symbolic link, and a receiver reports the path it actually wrote to, so
// the two would not compare equal.
const ARTIFACTS = await realpath(
  await mkdtemp(join(tmpdir(), 'ptransfer-pin-cli-e2e-')),
);
const children: ChildProcess[] = [];

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (line: string) => console.log(`${elapsed().padStart(8)} ${line}`);

interface Cli {
  child: ChildProcess;
  /** The first line the process writes to standard output. */
  firstLine: Promise<string>;
  /** Everything it wrote to standard output, once it has exited. */
  stdout: Promise<string>;
  exited: Promise<number>;
}

/** One CLI process, its output relayed line by line and kept. */
function runCli(label: string, args: string[], cwd = WEB_ROOT): Cli {
  // Absolute, since a receiver runs from its own inbox directory.
  const child = spawn(
    'bun',
    [join(WEB_ROOT, 'cli', 'main.ts'), ...args, ...VERBOSE],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.push(child);

  let stdout = '';
  let resolveFirst: (line: string) => void = () => {};
  const firstLine = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => {
    stdout += text;
    const newline = stdout.indexOf('\n');
    if (newline >= 0) resolveFirst(stdout.slice(0, newline));
    for (const line of text.split('\n')) {
      if (line) {
        say(`[${label} out] ${line.length > 80 ? `${line.slice(0, 77)}...` : line}`);
      }
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text: string) => {
    for (const line of text.split('\n')) {
      if (line) say(`[${label}] ${line}`);
    }
  });
  const exited = new Promise<number>((resolve) =>
    child.once('exit', (code) => resolve(code ?? -1)),
  );
  // 'exit' can come before the pipes drain; 'close' waits for them.
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  return { child, firstLine, stdout: closed.then(() => stdout), exited };
}

/**
 * The value of the first `label: value` line `cli` prints, or why it never
 * will. A PIN and a confirmation code are both handed over under a label, so
 * a script can split them off standard output.
 */
async function handedBy(
  cli: Cli,
  label: string,
  what: string,
): Promise<string> {
  const line = await withTimeout(
    Promise.race([
      cli.firstLine,
      cli.exited.then((status) => {
        throw new Error(
          `the ${label} exited with status ${status} before showing its ${what}`,
        );
      }),
    ]),
    TIMEOUT_MS,
    `the ${label}'s ${what}`,
  );
  const value = line.slice(line.indexOf(': ') + 2).trim();
  if (!value || !line.includes(': ')) {
    throw new Error(`the ${label} printed ${JSON.stringify(line)}, not a ${what}`);
  }
  return value;
}

/**
 * Settles once both processes exit 0, and rejects as soon as either exits
 * otherwise, rather than waiting on the other to time out.
 */
function bothSucceed(
  processes: { label: string; exited: Promise<number> }[],
): Promise<void> {
  return Promise.all(
    processes.map(({ label, exited }) =>
      exited.then((status) => {
        if (status !== 0) {
          throw new Error(`the ${label} exited with status ${status}`);
        }
      }),
    ),
  ).then(() => undefined);
}

/**
 * One `send --pin` of `paths` and one `receive --pin` of it into a fresh
 * `inbox`, both exiting 0; the path the receiver reports it saved.
 */
async function transfer(
  paths: string[],
  inbox: string,
  options: {
    viaOut?: boolean;
    senderArgs?: string[];
    receiverArgs?: string[];
  } = {},
): Promise<string> {
  await mkdir(inbox);
  const sender = runCli('sender', [
    'send',
    '--pin',
    ...paths,
    ...(options.senderArgs ?? []),
  ]);
  const pin = await handedBy(sender, 'sender', 'PIN');
  say(`the sender's PIN is ${pin.length} characters`);

  const receiver = runCli(
    'receiver',
    [
      'receive',
      '--pin',
      ...(options.viaOut ? ['--out', basename(inbox)] : []),
      ...(options.receiverArgs ?? []),
    ],
    options.viaOut ? dirname(inbox) : inbox,
  );
  receiver.child.stdin?.write(`${pin}\n`);
  const confirmation = await handedBy(
    receiver,
    'receiver',
    'confirmation code',
  );
  say(`the receiver's confirmation code is ${confirmation}`);
  sender.child.stdin?.write(`${confirmation}\n`);

  await withTimeout(
    bothSucceed([
      { label: 'receiver', exited: receiver.exited },
      { label: 'sender', exited: sender.exited },
    ]),
    TIMEOUT_MS,
    'the transfer',
  );
  const saved = (await receiver.stdout).trim().split('\n').pop() ?? '';
  if (dirname(saved) !== inbox) {
    throw new Error(`the receiver reported an unexpected path: ${saved}`);
  }
  return saved;
}

async function oneFile(
  scenario: string,
  bytes: number,
  options: Parameters<typeof transfer>[2] = {},
): Promise<void> {
  console.log(`\n=== CLI sender -> CLI receiver: ${scenario} ===`);
  const source = join(ARTIFACTS, `${scenario}.bin`);
  await writeFile(source, crypto.getRandomValues(new Uint8Array(bytes)));
  const saved = await transfer(
    [source],
    join(ARTIFACTS, `inbox-${scenario}`),
    options,
  );
  if (basename(saved) !== `${scenario}.bin`) {
    throw new Error(`the receiver saved an unexpected name: ${saved}`);
  }
  await assertSameBytes(source, saved, `${scenario} received file`);
}

async function folder(): Promise<void> {
  console.log('\n=== CLI sender -> CLI receiver: folder ===');
  const album = join(ARTIFACTS, 'album');
  await mkdir(join(album, 'nested'), { recursive: true });
  const sent: Record<string, Uint8Array> = {
    'album/cover.txt': new TextEncoder().encode('front cover\n'.repeat(50)),
    'album/nested/ünïcødé.bin': crypto.getRandomValues(new Uint8Array(400_000)),
    'loose.txt': new TextEncoder().encode('a loose file\n'),
  };
  await writeFile(join(album, 'cover.txt'), sent['album/cover.txt']);
  await writeFile(
    join(album, 'nested', 'ünïcødé.bin'),
    sent['album/nested/ünïcødé.bin'],
  );
  const loose = join(ARTIFACTS, 'loose.txt');
  await writeFile(loose, sent['loose.txt']);

  const saved = await transfer(
    [album, loose],
    join(ARTIFACTS, 'inbox-folder'),
    { viaOut: true },
  );
  if (!/^files_\d{14}\.zip$/.test(basename(saved))) {
    throw new Error(`the receiver saved an unexpected name: ${saved}`);
  }
  const received = unzipSync(new Uint8Array(await readFile(saved)));
  const names = Object.keys(received).sort();
  if (names.join('\n') !== Object.keys(sent).sort().join('\n')) {
    throw new Error(`the ZIP holds ${names.join(', ')}`);
  }
  for (const [name, bytes] of Object.entries(sent)) {
    if (Buffer.compare(Buffer.from(received[name]), Buffer.from(bytes)) !== 0) {
      throw new Error(`${name} came out of the ZIP changed`);
    }
  }
  say(`[PASS] folder: ${names.length} files intact in ${basename(saved)}`);
}

async function cleanup(): Promise<void> {
  for (const child of children) await terminate(child).catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

try {
  if (SCENARIOS.has('direct')) await oneFile('direct', 3_000_000);
  if (SCENARIOS.has('folder')) await folder();
  if (SCENARIOS.has('relay')) {
    await oneFile('relay', 600_000, { receiverArgs: ['--simulate-no-direct'] });
  }
  if (SCENARIOS.has('anonymous')) {
    await oneFile('anonymous', 600_000, {
      senderArgs: ['--anonymous', '--bridge', BRIDGE],
      receiverArgs: ['--simulate-no-direct', '--bridge', BRIDGE],
    });
  }
  console.log(`\nAll PIN Exchange CLI transfers passed in ${elapsed()}.`);
} catch (error) {
  console.error(`\n[FAIL] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
