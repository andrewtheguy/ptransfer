#!/usr/bin/env bun

// Live Tor CLI-to-CLI test: one `ptransfer send --tor` process publishes a
// v3 onion service and one `ptransfer receive --onion` process fetches it,
// over real circuits, the way two people at two terminals would.
//
//   bun run test:live:tor:cli
//
// Each process bootstraps its own Tor client. With the directory cached from
// an earlier run a bootstrap takes seconds; a cold one downloads ~40 MiB from
// the authorities first.
//
// Environment:
//   BRIDGE_URL, BRIDGE_FINGERPRINT  a Snowflake bridge for both processes to
//                                   use instead of the public one; both or
//                                   neither
//   TOR_TIMEOUT_MS                  how long the whole transfer may take
//                                   (default 480000)

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSameBytes,
  terminate,
  WEB_ROOT,
  withTimeout,
} from './support/live-harness.ts';

const TOR_TIMEOUT_MS = Number(process.env.TOR_TIMEOUT_MS ?? 8 * 60_000);
const BRIDGE_URL = process.env.BRIDGE_URL;
const BRIDGE_FINGERPRINT = process.env.BRIDGE_FINGERPRINT;
if (Boolean(BRIDGE_URL) !== Boolean(BRIDGE_FINGERPRINT)) {
  throw new Error('Set BRIDGE_URL and BRIDGE_FINGERPRINT together, or neither');
}
const BRIDGE_ARGS =
  BRIDGE_URL && BRIDGE_FINGERPRINT
    ? ['--bridge-url', BRIDGE_URL, '--bridge-fingerprint', BRIDGE_FINGERPRINT]
    : [];

const ARTIFACTS = await mkdtemp(join(tmpdir(), 'ptransfer-tor-cli-e2e-'));
const children: ChildProcess[] = [];

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (line: string) => console.log(`${elapsed().padStart(8)} ${line}`);

/** One CLI process, its output relayed line by line and kept. */
function runCli(
  label: string,
  args: string[],
  options: { cwd?: string; stdin?: string } = {},
): { child: ChildProcess; stdout: Promise<string>; exited: Promise<number> } {
  // Absolute, since a receiver runs from its own inbox directory.
  const child = spawn('bun', [join(WEB_ROOT, 'cli', 'main.ts'), ...args], {
    cwd: options.cwd ?? WEB_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  else child.stdin?.end();

  let stdout = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => {
    stdout += text;
    for (const line of text.split('\n')) {
      if (line) say(`[${label} out] ${line}`);
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
  return { child, stdout: exited.then(() => stdout), exited };
}

/**
 * Settles once both processes exit 0, and rejects as soon as either exits
 * otherwise: a sender whose receiver died keeps serving for half an hour, and
 * waiting on it would hide the failure behind the timeout.
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

/** The address and password the sender prints, as soon as it prints them. */
function waitForRendezvous(
  child: ChildProcess,
): Promise<{ address: string; password: string }> {
  return new Promise((resolve) => {
    let seen = '';
    child.stdout?.on('data', (text: string) => {
      seen += text;
      const address = /^address: (\S+)$/m.exec(seen)?.[1];
      const password = /^password: (\S+)$/m.exec(seen)?.[1];
      if (address && password) resolve({ address, password });
    });
  });
}

async function cliToCli(): Promise<void> {
  console.log('\n=== CLI sender -> CLI receiver (Tor) ===');
  const source = join(ARTIFACTS, 'cli-to-cli.txt');
  await writeFile(
    source,
    'pTransfer over Tor, terminal to terminal.\n'.repeat(400),
  );
  const inbox = join(ARTIFACTS, 'inbox');
  await mkdir(inbox);

  const sender = runCli('sender', ['send', '--tor', source, ...BRIDGE_ARGS]);
  const { address, password } = await withTimeout(
    Promise.race([
      waitForRendezvous(sender.child),
      sender.exited.then((status) => {
        throw new Error(
          `the sender exited with status ${status} before publishing`,
        );
      }),
    ]),
    TOR_TIMEOUT_MS,
    'the sender to publish its service',
  );
  say(`the sender is serving at ${address}`);

  const receiver = runCli(
    'receiver',
    ['receive', '--onion', address, ...BRIDGE_ARGS],
    { cwd: inbox, stdin: `${password}\n` },
  );
  await withTimeout(
    bothSucceed([
      { label: 'receiver', exited: receiver.exited },
      { label: 'sender', exited: sender.exited },
    ]),
    TOR_TIMEOUT_MS,
    'the transfer',
  );
  const saved = (await receiver.stdout).trim().split('\n').pop() ?? '';
  if (saved !== join(inbox, 'cli-to-cli.txt')) {
    throw new Error(`the receiver reported an unexpected path: ${saved}`);
  }
  await assertSameBytes(source, saved, 'cli -> cli received file');
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
  await cliToCli();
  console.log(`\nAll Tor CLI transfers passed in ${elapsed()}.`);
} catch (error) {
  console.error(`\n[FAIL] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
