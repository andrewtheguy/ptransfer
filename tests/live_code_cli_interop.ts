#!/usr/bin/env bun

// Live Code Exchange interoperability test: ptransfer-cli and a pTransfer
// browser tab transferring files to each other over hand-carried codes and a
// real WebRTC data channel, driven headlessly via Playwright.
//
//   cli -> cli   two CLIs exchange codes and transfer, with no browser in the
//                way
//   cli -> web   the CLI shows the offer; the page answers and downloads
//   web -> cli   the page shows the offer; the CLI answers and saves the file
//   relay legs   the same three legs with the ordinary fallback: the answering
//                side reports no direct route, so the file itself goes through
//                public Nostr relays instead of the data channel. These rest
//                on relays nobody monitors — enough of them have to be
//                reachable to prove a control set and a storage ring — so an
//                occasional failure here is the relay population, not the
//                implementations; re-run before believing it
//   anon legs    the same two browser legs with the anonymous fallback: the
//                answering side reports no direct route, so the file goes over
//                a Tor onion service instead of the data channel
//
// A failure therefore names the side that is wrong rather than just "Code
// Exchange does not work", and the CLI-to-CLI leg says whether the CLI is
// broken on its own before either browser leg is believed. Nothing here is
// mocked: real ICE, real data channels, and the same PT01 codes a person would
// carry.
//
// Only the copy/paste half of the exchange is exercised, because that is the
// half both implementations have: the CLI has no camera and draws no QR codes.
// The multi-QR offer path is browser-only and is covered by the web's own
// tests.
//
//   bun run test:live:code
//
// The anonymous legs bootstrap Tor on both sides. The browser's bootstrap is
// the slow half — it fetches the consensus and every HSDir microdescriptor one
// hop from its Snowflake bridge — so run a local bridge and point the test at
// it, which turns minutes into seconds:
//
//   cd ../webtor-rs && scripts/local-bridge/bridge.sh start
//   eval "$(../webtor-rs/scripts/local-bridge/bridge.sh env)" && bun run test:live:code
//
// The CLI reaches Tor directly rather than through a bridge, so its own
// bootstrap costs what it costs.
//
// The CLI checkout is built for the run, so what is under test is always the
// working tree next door rather than whatever was built there last.
//
// Environment:
//   PTRANSFER_CLI_ROOT              the ptransfer-cli checkout to build and
//                                   drive (default ../ptransfer-cli)
//   PTRANSFER_WEB_URL               dev server to start on, or to reuse when
//                                   PTRANSFER_E2E_REUSE_SERVER=1 (default
//                                   http://127.0.0.1:4173)
//   ONLY                            one leg: "cli-to-cli", "cli-to-web",
//                                   "web-to-cli", "cli-to-cli-relay",
//                                   "cli-to-web-relay", "web-to-cli-relay",
//                                   "cli-to-web-anon" or "web-to-cli-anon"
//   BRIDGE_URL, BRIDGE_FINGERPRINT  a Snowflake bridge for the browser to use
//                                   instead of the public one; both or neither
//   SKIP_ANON=1                     direct legs only
//   CHROME_PATH                     browser binary (default: known locations)

import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  assertSameBytes,
  ensureWebServer,
  findBrowser,
  instrumentPage,
  loadChromium,
  logPageConsole,
  type PwBrowser,
  type PwPage,
  readPackageIdentity,
  runCommand,
  sleep,
  terminate,
  warmWebApp,
  WEB_ROOT,
  withTimeout,
} from './support/live-harness.ts';

interface CommandExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface CliProcess {
  child: ChildProcessWithoutNullStreams;
  captured: { stdout: string; stderr: string };
  exit: Promise<CommandExit>;
  label: string;
}

const CLI_ROOT = resolve(
  process.env.PTRANSFER_CLI_ROOT ?? join(WEB_ROOT, '..', 'ptransfer-cli'),
);
const CLI = join(CLI_ROOT, 'target', 'debug', 'ptransfer');
const PROTOCOL_TS = join(WEB_ROOT, 'src', 'lib', 'protocol.ts');
const REQUESTED_WEB_URL = new URL(
  process.env.PTRANSFER_WEB_URL ?? 'http://127.0.0.1:4173',
);
const ONLY = process.env.ONLY ?? '';
const BRIDGE_URL = process.env.BRIDGE_URL;
const BRIDGE_FINGERPRINT = process.env.BRIDGE_FINGERPRINT;
const SKIP_ANON = process.env.SKIP_ANON === '1';

/**
 * A Tor bootstrap on both sides, an onion relay rendezvous, a descriptor
 * publication, and a transfer through the circuit that comes out of it. Slow
 * even when everything works, which is why the anonymous legs get a budget of
 * their own rather than the direct legs'.
 */
const TOR_TIMEOUT_MS = 12 * 60_000;

/**
 * The relay fallback's own budget. No Tor, but both sides still have to find
 * and health-check a ring of public storage relays, and then move the file
 * through them one 48 KiB event at a time.
 */
const RELAY_TIMEOUT_MS = 8 * 60_000;

/** A PT01 code in the base64 both sides copy and paste. */
const CODE = /^UFQwM[A-Za-z0-9+/]+=*$/;

/** The fields of a code this test reads. */
interface CodePayload {
  type: 'offer' | 'answer';
  sdp: string;
  candidates: string[];
  createdAt: number;
  confirm?: string;
  fileName?: string;
  fileSize?: number;
  anon?: true;
}

/**
 * A code that carried no ICE candidates.
 *
 * Chrome occasionally finishes gathering with an empty candidate list on this
 * kind of host, and a hand-carried code is a snapshot: unlike PIN Exchange
 * there is no trickle channel for a late candidate to arrive on, so the two
 * sides have nothing to connect with and the leg would sit out its timeout
 * for a reason that is not an interoperability failure. Recognized here so it
 * is retried and named rather than reported as one.
 */
class NoCandidatesError extends Error {}

const ARTIFACTS = await mkdtemp(join(tmpdir(), 'ptransfer-code-e2e-'));

let webUrl = REQUESTED_WEB_URL;
let browser: PwBrowser | undefined;
let ownedWebServer: ChildProcess | undefined;
const runningCli = new Set<ChildProcess>();
let cleanupStarted = false;

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (line: string) => console.log(`${elapsed().padStart(8)} ${line}`);

/**
 * Code Exchange's own container is versioned by its `PT01` magic, which is
 * refused rather than negotiated, so there is no coordination integer of its
 * own to compare. What the two sides still have to agree on is the transfer
 * layer underneath it — the 128 KiB chunks, `DONE` and `ACK` of
 * INTEROP_PROTOCOL.md — which is exactly what that version covers.
 */
async function assertProtocolVersionMatches(): Promise<void> {
  const cargoToml = await readFile(join(CLI_ROOT, 'Cargo.toml'), 'utf8');
  const protocolTs = await readFile(PROTOCOL_TS, 'utf8');

  const metadataMatch = cargoToml.match(
    /^ptransfer-protocol-version\s*=\s*"([^"]+)"\s*$/m,
  );
  if (!metadataMatch) {
    throw new Error(
      'Cargo.toml is missing package.metadata.ptransfer-protocol-version',
    );
  }
  const webMatch = protocolTs.match(/INTEROP_PROTOCOL_VERSION\s*=\s*'([^']+)'/);
  if (!webMatch) {
    throw new Error(`${PROTOCOL_TS} is missing INTEROP_PROTOCOL_VERSION`);
  }
  if (metadataMatch[1] !== webMatch[1]) {
    throw new Error(
      `Interop protocol version mismatch: ${CLI_ROOT}/Cargo.toml declares ` +
        `${metadataMatch[1]}, but ${PROTOCOL_TS} is ${webMatch[1]}`,
    );
  }
  say(`interop protocol version ${webMatch[1]}`);
}

/**
 * Read a PT01 code the way the app does: de-obfuscate with the current or
 * previous hourly seed, inflate, parse.
 *
 * The test decodes what it carries rather than passing it along blind, so a
 * code that is malformed, of the wrong half, or carrying no ICE candidates is
 * named where it happens instead of surfacing later as a transfer that never
 * connects.
 */
function decodeCode(text: string): CodePayload {
  const binary = Buffer.from(text, 'base64');
  if (binary.subarray(0, 4).toString('latin1') !== 'PT01') {
    throw new Error('not a PT01 code');
  }
  const bucket = Math.floor(Date.now() / 1000 / 3600);
  for (const epoch of [bucket, bucket - 1]) {
    let h = 0x9e3779b9 ^ epoch;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    let state = (h ^ (h >>> 16)) >>> 0;

    const inner = Buffer.alloc(binary.length - 4);
    for (let i = 0; i < inner.length; i += 1) {
      state ^= (state << 13) >>> 0;
      state ^= state >>> 17;
      state ^= (state << 5) >>> 0;
      state >>>= 0;
      inner[i] = binary[4 + i] ^ (state & 0xff);
    }
    if (inner.subarray(0, 4).toString('latin1') !== 'mag!') continue;
    return JSON.parse(
      inflateRawSync(inner.subarray(4)).toString('utf8'),
    ) as CodePayload;
  }
  throw new Error('no hourly seed decoded the code');
}

/** Parse a code, check it is the half it should be, and that it can connect. */
function readCode(
  text: string,
  expected: 'offer' | 'answer',
  label: string,
  /** Set where an empty candidate list is the point: a simulated dead route. */
  allowEmpty = false,
): CodePayload {
  const payload = decodeCode(text);
  if (payload.type !== expected) {
    throw new Error(`${label} is a ${payload.type}, not an ${expected}`);
  }
  if (expected === 'answer' && !payload.confirm) {
    throw new Error(`${label} carries no confirmation tag`);
  }
  if (payload.candidates.length === 0 && !allowEmpty) {
    throw new NoCandidatesError(`${label} carried no ICE candidates`);
  }
  return payload;
}

/**
 * Run one leg, retrying it when a code came out with no ICE candidates.
 *
 * Every retry is announced, so a leg that only passes on the third try still
 * says so rather than looking clean.
 */
async function withCandidates(
  label: string,
  attempt: () => Promise<void>,
): Promise<void> {
  for (let remaining = 3; ; remaining -= 1) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (!(error instanceof NoCandidatesError) || remaining <= 1) throw error;
      say(`${label}: ${error.message} — retrying`);
    }
  }
}

/** Run the CLI, collecting its output for the assertions and for failures. */
function runCli(args: string[], label: string): CliProcess {
  const child = spawn(CLI, args, {
    cwd: CLI_ROOT,
    env: { ...process.env, RUST_LOG: 'error,webrtc_ice=error' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  runningCli.add(child);

  const captured = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    captured.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    captured.stderr += chunk.toString();
  });
  const exit = new Promise<CommandExit>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      runningCli.delete(child);
      resolvePromise({ code, signal });
    });
  });
  return { child, captured, exit, label };
}

function outputTail(text: string, maximum = 4_000): string {
  return text.length > maximum ? `…${text.slice(-maximum)}` : text;
}

function cliFailure(processHandle: CliProcess, detail: string): Error {
  return new Error(
    `${processHandle.label}: ${detail}\n` +
      `stdout:\n${outputTail(processHandle.captured.stdout)}\n` +
      `stderr:\n${outputTail(processHandle.captured.stderr)}`,
  );
}

async function waitForStdoutLine(
  processHandle: CliProcess,
  predicate: (line: string) => boolean,
  description: string,
  timeoutMs = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = processHandle.captured.stdout
      .split(/\r?\n/)
      .map((line) => line.trim());
    const match = lines.find(predicate);
    if (match !== undefined) {
      return match;
    }
    if (
      processHandle.child.exitCode !== null ||
      processHandle.child.signalCode !== null
    ) {
      throw cliFailure(processHandle, `exited before producing ${description}`);
    }
    await sleep(100);
  }
  throw cliFailure(processHandle, `timed out waiting for ${description}`);
}

async function waitForCliSuccess(
  processHandle: CliProcess,
  description: string,
  timeoutMs = 180_000,
): Promise<void> {
  const result = await withTimeout(processHandle.exit, timeoutMs, description);
  if (result.code !== 0) {
    throw cliFailure(
      processHandle,
      `exited with code ${result.code ?? 'null'}, signal ${result.signal ?? 'none'}`,
    );
  }
}

/**
 * Reveal the copy/paste text under a code and read it.
 *
 * Both sides of the exchange offer the same escape hatch for a browser whose
 * clipboard is blocked, and it is the one path a headless test can read
 * without granting clipboard permissions — the same bytes `Copy Data` writes.
 */
async function readShownCode(
  page: PwPage,
  label: string,
  options: { timeoutMs?: number; not?: string } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  // The trigger's own wording depends on whether the browser would let the
  // page write to the clipboard, and the same phrase appears in the
  // instructions above it, so match the button by role.
  const trigger = page.getByRole('button', { name: /Show text to copy/ });
  const textarea = page.getByRole('textbox', { name: label, exact: true });

  // The text is behind a collapsible that the page closes again whenever it
  // rebuilds the code, so this reveals it, reads it, and — if the code it
  // finds is the one being replaced — waits for the new one and reveals it
  // again. Handing the sender a code the page has already replaced would fail
  // the confirmation check for a reason that is not an interop failure.
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  for (;;) {
    const open = await textarea
      .waitFor({ state: 'visible', timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (open) {
      seen = (await textarea.inputValue()).trim();
      if (CODE.test(seen) && seen !== options.not) return seen;
    } else {
      await trigger
        .waitFor({ state: 'visible', timeout: 1_000 })
        .then(() => trigger.click())
        .catch(() => {});
    }
    if (Date.now() > deadline) {
      throw new Error(
        seen === options.not && seen !== ''
          ? `The page's ${label} never changed`
          : `The page never showed a ${label}: ${seen.slice(0, 40) || '(nothing)'}`,
      );
    }
    await sleep(250);
  }
}

/**
 * Bytes for the multi-chunk fixture: a poorly-compressible half (deflate
 * barely shrinks it, so the wire payload stays large) followed by a highly
 * compressible half (so the deflate/inflate path does real work in both
 * directions). Deterministic, so a failure is reproducible.
 */
function multiChunkBytes(byteLength: number): Buffer {
  const out = Buffer.alloc(byteLength);
  const half = byteLength >> 1;
  let state = 0x9e3779b9n;
  for (let i = 0; i < half; i += 1) {
    state ^= (state << 13n) & 0xffffffffffffffffn;
    state ^= state >> 7n;
    state ^= (state << 17n) & 0xffffffffffffffffn;
    out[i] = Number((state >> 24n) & 0xffn);
  }
  out.fill(
    'pTransfer interop payload, repeating so deflate has work to do. ',
    half,
  );
  return out;
}

/**
 * A payload large enough to span many 128 KiB wire chunks in both directions.
 *
 * A small fixture fits in a single chunk, so it exercises none of the
 * streaming path: chunk indices stay at 0, backpressure never engages, and a
 * data channel that negotiated *unordered* delivery looks perfectly healthy.
 */
async function multiChunkFixture(): Promise<string> {
  const path = join(ARTIFACTS, 'bulk-payload.bin');
  await writeFile(path, multiChunkBytes(12 * 1024 * 1024));
  return path;
}

/** Two CLIs, no browser: the leg that says whether the CLI itself works. */
async function cliToCli(): Promise<void> {
  console.log('\n=== CLI sender -> CLI receiver ===');
  const source = join(CLI_ROOT, 'README.md');
  const outputDir = await mkdtemp(join(ARTIFACTS, 'cli-to-cli-'));

  const sender = runCli(['code', 'send', source], 'CLI sender');
  const offer = await waitForStdoutLine(
    sender,
    (line) => CODE.test(line),
    'sender offer code',
  );
  say(`the CLI sender's offer is ${offer.length} characters`);

  const offered = readCode(offer, 'offer', "the CLI sender's code");
  if (offered.fileName !== 'README.md') {
    throw new Error(`the CLI sender's code names ${offered.fileName}`);
  }

  const receiver = runCli(
    ['code', 'receive', '--output', outputDir],
    'CLI receiver',
  );
  // The offer is the secret for the whole transfer, so it goes in on stdin
  // rather than as an argument every other process could read.
  receiver.child.stdin.write(`${offer}\n`);
  const response = await waitForStdoutLine(
    receiver,
    (line) => CODE.test(line),
    'receiver response code',
  );
  say(`the CLI receiver's response is ${response.length} characters`);
  readCode(response, 'answer', "the CLI receiver's response");
  sender.child.stdin.write(`${response}\n`);

  await Promise.all([
    waitForCliSuccess(sender, 'CLI sender'),
    waitForCliSuccess(receiver, 'CLI receiver'),
  ]);
  await assertSameBytes(
    source,
    join(outputDir, 'README.md'),
    'cli -> cli transferred file',
  );
}

/** The CLI shows the offer; the page answers it and downloads the file. */
async function cliToWeb(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== CLI sender -> web receiver ===');
  const context = await activeBrowser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web receiver');
  logPageConsole(page, 'web receiver', say);
  try {
    const source = await multiChunkFixture();
    const sender = runCli(['code', 'send', source], 'CLI sender');
    const offer = await waitForStdoutLine(
      sender,
      (line) => CODE.test(line),
      'sender offer code',
    );
    say(`the CLI sender's offer is ${offer.length} characters`);

    await page.goto(new URL('/receive', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    // The scanner is the default tab, and the paste tab is the half of the
    // exchange a CLI can take part in.
    const pasteTab = page.getByRole('tab', { name: 'Paste', exact: true });
    await pasteTab.waitFor({ state: 'visible', timeout: 30_000 });
    await pasteTab.click();
    const receiveInput = page.getByRole('textbox', {
      name: 'PIN, onion address, or sender code',
      exact: true,
    });
    await receiveInput.waitFor({ state: 'visible', timeout: 30_000 });
    await receiveInput.fill(offer);
    await page.getByRole('button', { name: 'Receive', exact: true }).click();

    const response = await readShownCode(page, 'Response data to copy');
    say(`the web receiver's response is ${response.length} characters`);
    readCode(response, 'answer', "the web receiver's response");
    sender.child.stdin.write(`${response}\n`);

    const downloadButton = page.getByRole('button', { name: 'Download File' });
    await downloadButton.waitFor({ state: 'visible', timeout: 180_000 });
    await waitForCliSuccess(sender, 'CLI sender');

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const downloaded = join(ARTIFACTS, 'cli-to-web-bulk-payload.bin');
    await (await downloadPromise).saveAs(downloaded);
    await assertSameBytes(source, downloaded, 'cli -> web downloaded file');
    assertNoPageErrors();
  } finally {
    await context.close();
  }
}

/** The page shows the offer; the CLI answers it and saves the file. */
async function webToCli(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== Web sender -> CLI receiver ===');
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web sender');
  logPageConsole(page, 'web sender', say);
  try {
    const source = await multiChunkFixture();
    const outputDir = await mkdtemp(join(ARTIFACTS, 'web-to-cli-'));

    await page.goto(new URL('/send', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('input[type="file"]').first().setInputFiles(source);
    await page.locator('#send-mode-code').click();
    await page.getByRole('button', { name: 'Start Code Exchange' }).click();

    // The ordinary offer waits on a relay probe before it can name the
    // fallback's control relays, so the code takes a few seconds to appear.
    const offer = await readShownCode(page, 'Connection data to copy');
    say(`the web sender's offer is ${offer.length} characters`);
    readCode(offer, 'offer', "the web sender's code");

    const receiver = runCli(
      ['code', 'receive', '--output', outputDir],
      'CLI receiver',
    );
    receiver.child.stdin.write(`${offer}\n`);
    const response = await waitForStdoutLine(
      receiver,
      (line) => CODE.test(line),
      'receiver response code',
    );
    say(`the CLI receiver's response is ${response.length} characters`);
    readCode(response, 'answer', "the CLI receiver's response");

    // The scanner is the default tab; the paste tab is the half of the
    // exchange the CLI can take part in.
    await page.getByRole('tab', { name: 'Paste', exact: true }).click();
    const responseInput = page.getByRole('textbox', {
      name: "Receiver's response code",
      exact: true,
    });
    await responseInput.waitFor({ state: 'visible', timeout: 30_000 });
    await responseInput.fill(response);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();

    await waitForCliSuccess(receiver, 'CLI receiver');
    await page.getByText('Transfer Complete!', { exact: true }).waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    await assertSameBytes(
      source,
      join(outputDir, 'bulk-payload.bin'),
      'web -> cli saved file',
    );
    assertNoPageErrors();
  } finally {
    await context.close();
  }
}

/**
 * The relay legs: the same exchange, with the file itself going through public
 * Nostr relays because no direct connection could be made.
 *
 * What makes them the relay fallback rather than the anonymous one is the
 * offer: an ordinary code names the control relays the sender proved before it
 * was shown, and the answering side reports no direct route the same way it
 * does for Tor — a response with none of its network routes in it.
 */
async function relayFixture(name: string): Promise<string> {
  const path = join(ARTIFACTS, name);
  await writeFile(path, multiChunkBytes(512 * 1024));
  return path;
}

/** Assert an ordinary offer named the relays its fallback needs. */
function assertNamesRelays(code: string, label: string): void {
  const payload = decodeCode(code) as CodePayload & { relays?: string[] };
  if (!payload.relays || payload.relays.length < 2) {
    throw new Error(`${label} named no relays, so it has no relay fallback`);
  }
  say(`${label} names ${payload.relays.length} control relays`);
}

/** Two CLIs, no browser: the relay leg that says whether the CLI itself works. */
async function cliToCliRelay(): Promise<void> {
  console.log('\n=== CLI sender -> CLI receiver (relay fallback) ===');
  const source = await relayFixture('relay-cli-to-cli.bin');
  const outputDir = await mkdtemp(join(ARTIFACTS, 'relay-cli-to-cli-'));

  const sender = runCli(['code', 'send', source], 'CLI sender');
  const offer = await waitForStdoutLine(
    sender,
    (line) => CODE.test(line),
    'sender offer code',
  );
  readCode(offer, 'offer', "the CLI sender's code");
  assertNamesRelays(offer, "the CLI sender's code");

  const receiver = runCli(
    ['code', 'receive', '--simulate-no-direct', '--output', outputDir],
    'CLI receiver',
  );
  receiver.child.stdin.write(`${offer}\n`);
  const response = await waitForStdoutLine(
    receiver,
    (line) => CODE.test(line),
    'receiver response code',
  );
  const answered = readCode(response, 'answer', "the CLI receiver's response", true);
  if (answered.candidates.length !== 0) {
    throw new Error('the simulated response still carries network routes');
  }
  say('the CLI receiver reports no direct route; the file goes through relays');
  sender.child.stdin.write(`${response}\n`);

  await Promise.all([
    waitForCliSuccess(sender, 'CLI sender', RELAY_TIMEOUT_MS),
    waitForCliSuccess(receiver, 'CLI receiver', RELAY_TIMEOUT_MS),
  ]);
  await assertSameBytes(
    source,
    join(outputDir, 'relay-cli-to-cli.bin'),
    'cli -> cli through relays',
  );
}

async function cliToWebRelay(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== CLI sender -> web receiver (relay fallback) ===');
  const context = await activeBrowser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web receiver');
  logPageConsole(page, 'web receiver', say);
  try {
    const source = await relayFixture('relay-cli-to-web.bin');
    const sender = runCli(['code', 'send', source], 'CLI sender');
    const offer = await waitForStdoutLine(
      sender,
      (line) => CODE.test(line),
      'sender offer code',
    );
    readCode(offer, 'offer', "the CLI sender's code");
    assertNamesRelays(offer, "the CLI sender's code");

    await page.goto(new URL('/receive', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    const pasteTab = page.getByRole('tab', { name: 'Paste', exact: true });
    await pasteTab.waitFor({ state: 'visible', timeout: 30_000 });
    await pasteTab.click();
    const receiveInput = page.getByRole('textbox', {
      name: 'PIN, onion address, or sender code',
      exact: true,
    });
    await receiveInput.waitFor({ state: 'visible', timeout: 30_000 });
    await receiveInput.fill(offer);
    await page.getByRole('button', { name: 'Receive', exact: true }).click();

    const direct = await readShownCode(page, 'Response data to copy');
    say('the web receiver answered; asking it to report no direct route');
    await page.getByRole('button', { name: 'Advanced options' }).click();
    await page
      .getByRole('button', { name: 'Simulate no direct connection' })
      .click();
    const response = await readShownCode(page, 'Response data to copy', {
      not: direct,
    });
    const answered = readCode(
      response,
      'answer',
      "the web receiver's response",
      true,
    );
    if (answered.candidates.length !== 0) {
      throw new Error('the simulated response still carries network routes');
    }
    say('the web receiver reports no direct route; the file goes through relays');
    sender.child.stdin.write(`${response}\n`);

    const downloadButton = page.getByRole('button', { name: 'Download File' });
    await downloadButton.waitFor({ state: 'visible', timeout: RELAY_TIMEOUT_MS });
    await waitForCliSuccess(sender, 'CLI sender', RELAY_TIMEOUT_MS);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const downloaded = join(ARTIFACTS, 'relay-cli-to-web-downloaded.bin');
    await (await downloadPromise).saveAs(downloaded);
    await assertSameBytes(source, downloaded, 'cli -> web through relays');
    assertNoPageErrors();
  } finally {
    await context.close();
  }
}

async function webToCliRelay(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== Web sender -> CLI receiver (relay fallback) ===');
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web sender');
  logPageConsole(page, 'web sender', say);
  try {
    const source = await relayFixture('relay-web-to-cli.bin');
    const outputDir = await mkdtemp(join(ARTIFACTS, 'relay-web-to-cli-'));

    await page.goto(new URL('/send', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('input[type="file"]').first().setInputFiles(source);
    await page.locator('#send-mode-code').click();
    await page.getByRole('button', { name: 'Start Code Exchange' }).click();

    const offer = await readShownCode(page, 'Connection data to copy');
    readCode(offer, 'offer', "the web sender's code");
    assertNamesRelays(offer, "the web sender's code");

    const receiver = runCli(
      ['code', 'receive', '--simulate-no-direct', '--output', outputDir],
      'CLI receiver',
    );
    receiver.child.stdin.write(`${offer}\n`);
    const response = await waitForStdoutLine(
      receiver,
      (line) => CODE.test(line),
      'receiver response code',
    );
    const answered = readCode(
      response,
      'answer',
      "the CLI receiver's response",
      true,
    );
    if (answered.candidates.length !== 0) {
      throw new Error('the simulated response still carries network routes');
    }
    say('the CLI receiver reports no direct route; the file goes through relays');

    await page.getByRole('tab', { name: 'Paste', exact: true }).click();
    const responseInput = page.getByRole('textbox', {
      name: "Receiver's response code",
      exact: true,
    });
    await responseInput.waitFor({ state: 'visible', timeout: 30_000 });
    await responseInput.fill(response);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();

    await waitForCliSuccess(receiver, 'CLI receiver', RELAY_TIMEOUT_MS);
    await assertSameBytes(
      source,
      join(outputDir, 'relay-web-to-cli.bin'),
      'web -> cli through relays',
    );
    assertNoPageErrors();
  } finally {
    await context.close();
  }
}

/**
 * The two anonymous legs, which differ only in which side publishes the onion
 * service — and, with it, which side has to be told there is no direct route.
 *
 * The Tor fallback is what a transfer falls back *to*, so a leg that connected
 * directly would prove nothing about it. Both implementations offer the same
 * affordance for that: the answering side builds its response with none of its
 * network routes in it, which is the situation a device behind a hostile NAT
 * is in anyway.
 */
async function cliToWebAnonymous(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== CLI sender -> web receiver (anonymous fallback) ===');
  const context = await activeBrowser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web receiver');
  logPageConsole(page, 'web receiver', say);
  try {
    // Small: this one crawls down a Tor circuit rather than a data channel.
    const source = join(ARTIFACTS, 'anon-cli-to-web.txt');
    await writeFile(source, 'pTransfer over Tor, line after line.\n'.repeat(400));

    const sender = runCli(['code', 'send', '--anonymous', source], 'CLI sender');
    const offer = await waitForStdoutLine(
      sender,
      (line) => CODE.test(line),
      'sender offer code',
    );
    const offered = readCode(offer, 'offer', "the CLI sender's code");
    if (offered.anon !== true) {
      throw new Error('the CLI sender did not mark its code anonymous');
    }
    say(`the CLI sender's anonymous offer is ${offer.length} characters`);

    await page.goto(new URL('/receive', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    const pasteTab = page.getByRole('tab', { name: 'Paste', exact: true });
    await pasteTab.waitFor({ state: 'visible', timeout: 30_000 });
    await pasteTab.click();
    const receiveInput = page.getByRole('textbox', {
      name: 'PIN, onion address, or sender code',
      exact: true,
    });
    await receiveInput.waitFor({ state: 'visible', timeout: 30_000 });
    await receiveInput.fill(offer);
    await page.getByRole('button', { name: 'Receive', exact: true }).click();

    // The code's own flag is what puts this question on screen: which bridge
    // this device reaches Tor through. Answering it starts the bootstrap.
    const continueButton = page.getByRole('button', {
      name: 'Continue',
      exact: true,
    });
    await continueButton.waitFor({ state: 'visible', timeout: 60_000 });
    await continueButton.click();

    const direct = await readShownCode(page, 'Response data to copy');
    say('the web receiver answered; asking it to report no direct route');
    await page.getByRole('button', { name: 'Advanced options' }).click();
    await page
      .getByRole('button', { name: 'Simulate no direct connection' })
      .click();
    // Rebuilding the connection changes the code, so the sender must be handed
    // the one on screen now rather than the one it replaced.
    const response = await readShownCode(page, 'Response data to copy', {
      not: direct,
    });
    const answered = readCode(
      response,
      'answer',
      "the web receiver's response",
      true,
    );
    if (answered.candidates.length !== 0) {
      throw new Error('the simulated response still carries network routes');
    }
    say('the web receiver reports no direct route; the file goes over Tor');
    sender.child.stdin.write(`${response}\n`);

    const downloadButton = page.getByRole('button', { name: 'Download File' });
    await downloadButton.waitFor({ state: 'visible', timeout: TOR_TIMEOUT_MS });
    await waitForCliSuccess(sender, 'CLI sender', TOR_TIMEOUT_MS);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const downloaded = join(ARTIFACTS, 'anon-cli-to-web-downloaded.txt');
    await (await downloadPromise).saveAs(downloaded);
    await assertSameBytes(source, downloaded, 'cli -> web over Tor');
    assertNoPageErrors();
  } finally {
    await context.close();
  }
}

async function webToCliAnonymous(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== Web sender -> CLI receiver (anonymous fallback) ===');
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web sender');
  logPageConsole(page, 'web sender', say);
  try {
    const source = join(ARTIFACTS, 'anon-web-to-cli.txt');
    await writeFile(source, 'pTransfer over Tor, line after line.\n'.repeat(400));
    const outputDir = await mkdtemp(join(ARTIFACTS, 'anon-web-to-cli-'));

    await page.goto(new URL('/send', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('input[type="file"]').first().setInputFiles(source);
    await page.locator('#send-mode-code').click();
    await page.getByRole('button', { name: 'Advanced options' }).click();
    await page.locator('#send-anonymous-relay').click();
    await page.getByRole('button', { name: 'Start Code Exchange' }).click();

    const offer = await readShownCode(page, 'Connection data to copy');
    const offered = readCode(offer, 'offer', "the web sender's code");
    if (offered.anon !== true) {
      throw new Error('the web sender did not mark its code anonymous');
    }
    say(`the web sender's anonymous offer is ${offer.length} characters`);

    // The CLI's own way of reporting no direct route: the response goes back
    // with none of its network routes in it.
    const receiver = runCli(
      ['code', 'receive', '--simulate-no-direct', '--output', outputDir],
      'CLI receiver',
    );
    receiver.child.stdin.write(`${offer}\n`);
    const response = await waitForStdoutLine(
      receiver,
      (line) => CODE.test(line),
      'receiver response code',
    );
    const answered = readCode(
      response,
      'answer',
      "the CLI receiver's response",
      true,
    );
    if (answered.candidates.length !== 0) {
      throw new Error('the simulated response still carries network routes');
    }
    say('the CLI receiver reports no direct route; the file goes over Tor');

    await page.getByRole('tab', { name: 'Paste', exact: true }).click();
    const responseInput = page.getByRole('textbox', {
      name: "Receiver's response code",
      exact: true,
    });
    await responseInput.waitFor({ state: 'visible', timeout: 30_000 });
    await responseInput.fill(response);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();

    await waitForCliSuccess(receiver, 'CLI receiver', TOR_TIMEOUT_MS);
    await assertSameBytes(
      source,
      join(outputDir, 'anon-web-to-cli.txt'),
      'web -> cli over Tor',
    );
    assertNoPageErrors();
  } finally {
    await context.close();
  }
}

async function cleanup(): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;
  for (const child of runningCli) {
    await terminate(child).catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  await terminate(ownedWebServer, true).catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

try {
  await assertProtocolVersionMatches();
  const expectedWebPackage = await readPackageIdentity();
  say(`pTransfer ${expectedWebPackage.version}, CLI checkout at ${CLI_ROOT}`);
  await runCommand('cargo', ['build'], { cwd: CLI_ROOT });

  if (Boolean(BRIDGE_URL) !== Boolean(BRIDGE_FINGERPRINT)) {
    throw new Error('Set BRIDGE_URL and BRIDGE_FINGERPRINT together, or neither');
  }
  const needsBrowser = ONLY !== 'cli-to-cli' && ONLY !== 'cli-to-cli-relay';
  if (needsBrowser) {
    if (BRIDGE_URL) say(`browser bridge: ${BRIDGE_URL}`);
    const chromium = await loadChromium();
    const executablePath = await findBrowser();
    // The dev server, not this process, is what has to see the bridge
    // settings: they reach the page as build-time `import.meta.env` values.
    const server = await ensureWebServer(expectedWebPackage, REQUESTED_WEB_URL, {
      ...process.env,
      ...(BRIDGE_URL && BRIDGE_FINGERPRINT
        ? {
            VITE_TOR_BRIDGE_URL: BRIDGE_URL,
            VITE_TOR_BRIDGE_FINGERPRINT: BRIDGE_FINGERPRINT,
          }
        : {}),
    });
    webUrl = server.url;
    ownedWebServer = server.process;

    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Host candidates as plain addresses rather than mDNS names, which
        // nothing outside a browser can resolve. Code Exchange hands its
        // candidates over once, in the code, so a peer that cannot use them
        // has no second chance at a direct route.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    });
    await warmWebApp(browser, webUrl, say);
  }

  const active = browser;
  if (!ONLY || ONLY === 'cli-to-cli') {
    await withCandidates('cli -> cli', () => cliToCli());
  }
  if (active && (!ONLY || ONLY === 'cli-to-web')) {
    await withCandidates('cli -> web', () => cliToWeb(active));
  }
  if (active && (!ONLY || ONLY === 'web-to-cli')) {
    await withCandidates('web -> cli', () => webToCli(active));
  }
  if (!ONLY || ONLY === 'cli-to-cli-relay') {
    await withCandidates('cli -> cli (relay)', () => cliToCliRelay());
  }
  if (active && (!ONLY || ONLY === 'cli-to-web-relay')) {
    await withCandidates('cli -> web (relay)', () => cliToWebRelay(active));
  }
  if (active && (!ONLY || ONLY === 'web-to-cli-relay')) {
    await withCandidates('web -> cli (relay)', () => webToCliRelay(active));
  }
  if (active && !SKIP_ANON && (!ONLY || ONLY === 'cli-to-web-anon')) {
    await withCandidates('cli -> web (anon)', () => cliToWebAnonymous(active));
  }
  if (active && !SKIP_ANON && (!ONLY || ONLY === 'web-to-cli-anon')) {
    await withCandidates('web -> cli (anon)', () => webToCliAnonymous(active));
  }
  console.log(`\nCODE EXCHANGE INTEROP LIVE TEST PASSED\nArtifacts: ${ARTIFACTS}`);
} catch (error) {
  console.error(
    `\nCODE EXCHANGE INTEROP LIVE TEST FAILED\n${(error as Error).stack ?? error}`,
  );
  console.error(`Artifacts: ${ARTIFACTS}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
