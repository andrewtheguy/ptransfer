#!/usr/bin/env bun

// Live WebRTC interoperability test: ptransfer-cli and a pTransfer browser tab
// transferring files to each other over PIN Exchange, the public Nostr relays
// and a real WebRTC data channel, driven headlessly via Playwright.
//
//   cli -> cli   two CLIs pair and transfer, with no browser in the way
//   cli -> web   the CLI sends; the page receives and downloads the file
//   web -> cli   the page sends; the CLI receives and saves the file
//
// A failure therefore names the side that is wrong rather than just "transfers
// do not work", and the CLI-to-CLI leg says whether the CLI is broken on its
// own before either browser leg is believed. Nothing here is mocked: real
// relays, real ICE, real data channels. `live_tor_cli_interop.ts` is the same
// idea for the Tor transport.
//
//   bun run test:live:webrtc
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
//   CHROME_PATH                     browser binary (default: known locations)

import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const CONFIRMATION_CODE = /^[0-9A-HJKMNPQRSTVWXYZ]{8}$/;

const ARTIFACTS = await mkdtemp(join(tmpdir(), 'ptransfer-webrtc-e2e-'));

let webUrl = REQUESTED_WEB_URL;
let browser: PwBrowser | undefined;
let ownedWebServer: ChildProcess | undefined;
const runningCli = new Set<ChildProcess>();
let cleanupStarted = false;

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (line: string) => console.log(`${elapsed().padStart(8)} ${line}`);

/**
 * The two sides agree on the *interop* protocol version, not this app's npm
 * version: the app bumps its patch version for changes in parts of it no other
 * implementation speaks. The npm version is still read, but only so the
 * harness can tell whether the server it finds is serving the checkout it was
 * pointed at.
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
  timeoutMs = 150_000,
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
 * Warm the QR worker and the WASM module behind it, which the shared page
 * warm-up does not reach.
 *
 * On a cold Vite cache the first render of a QR triggers dependency
 * optimization and a full page reload; landing that mid-transfer takes the
 * transfer with it. The about page is simply the cheapest page that draws one.
 */
async function warmQrWorker(activeBrowser: PwBrowser): Promise<void> {
  say('warming the QR worker');
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(new URL('/about', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    await page
      .getByRole('img', { name: 'Scan to open on mobile' })
      .waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForLoadState('networkidle');
  } finally {
    await context.close();
  }
}

async function readWebConfirmationCode(page: PwPage): Promise<string> {
  await page.waitForFunction(
    () =>
      /Confirmation code\s+[0-9A-Z]{4}-[0-9A-Z]{4}/.test(document.body.innerText),
    null,
    { timeout: 120_000 },
  );
  const text = await page.locator('body').innerText();
  const match = text.match(/Confirmation code\s+([0-9A-Z]{4})-([0-9A-Z]{4})/);
  if (!match) {
    throw new Error('Web receiver confirmation code was not found');
  }
  return `${match[1]}${match[2]}`;
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
 * That is exactly how a reliable-unordered channel reached a browser
 * undetected, so the browser legs carry a multi-chunk payload.
 */
async function multiChunkFixture(): Promise<string> {
  const path = join(ARTIFACTS, 'bulk-payload.bin');
  const bytes = multiChunkBytes(12 * 1024 * 1024);
  await writeFile(path, bytes);
  return path;
}

/** Two CLIs, no browser: the leg that says whether the CLI itself works. */
async function cliToCli(): Promise<void> {
  console.log('\n=== CLI sender -> CLI receiver ===');
  const source = join(CLI_ROOT, 'README.md');
  const outputDir = await mkdtemp(join(ARTIFACTS, 'cli-to-cli-'));
  const sender = runCli(['test', 'send', source], 'CLI sender');
  const pin = await waitForStdoutLine(
    sender,
    (line) => line.length === 12,
    'sender PIN',
  );
  say(`the CLI sender's PIN is ${pin}`);

  const receiver = runCli(
    ['test', 'receive', '--output', outputDir],
    'CLI receiver',
  );
  // The PIN is never an argument: it would be readable in the process list for
  // as long as the receiver runs.
  receiver.child.stdin.write(`${pin}\n`);
  const confirmationCode = await waitForStdoutLine(
    receiver,
    (line) => CONFIRMATION_CODE.test(line),
    'receiver confirmation code',
  );
  say(`the CLI receiver's confirmation code is ${confirmationCode}`);
  sender.child.stdin.write(`${confirmationCode}\n`);

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

/** The CLI sends; the page receives it and downloads the file. */
async function cliToWeb(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== CLI sender -> web receiver ===');
  const context = await activeBrowser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web receiver');
  logPageConsole(page, 'web receiver', say);
  try {
    const source = await multiChunkFixture();
    const sender = runCli(['test', 'send', source], 'CLI sender');
    const pin = await waitForStdoutLine(
      sender,
      (line) => line.length === 12,
      'sender PIN',
    );
    say(`the CLI sender's PIN is ${pin}`);

    // The PIN deep link is what a scanned PIN QR opens: it lands on the
    // consolidated receive screen with the Paste tab selected and the input
    // prefilled, so the test does not have to drive the tab itself.
    await page.goto(new URL(`/receive#p=${pin}`, webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    const receiveInput = page.getByRole('textbox', {
      name: 'PIN, onion address, or sender code',
      exact: true,
    });
    await receiveInput.waitFor({ state: 'visible', timeout: 30_000 });
    // Fail loudly if the deep link stopped prefilling, rather than waiting out
    // a timeout on the disabled Receive button.
    if ((await receiveInput.inputValue()) !== pin) {
      throw new Error('The PIN deep link did not prefill the receive input');
    }
    await page.getByRole('button', { name: 'Receive', exact: true }).click();

    const confirmationCode = await readWebConfirmationCode(page);
    say(`the web receiver's confirmation code is ${confirmationCode}`);
    sender.child.stdin.write(`${confirmationCode}\n`);

    const downloadButton = page.getByRole('button', { name: 'Download File' });
    await downloadButton.waitFor({ state: 'visible', timeout: 150_000 });
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

/** The page sends; the CLI receives it and saves the file. */
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
    await page.getByRole('button', { name: 'Start PIN Exchange' }).click();

    const pinInput = page.getByRole('textbox', { name: 'PIN', exact: true });
    await pinInput.waitFor({ state: 'visible', timeout: 120_000 });
    const pin = await pinInput.inputValue();
    if (pin.length !== 12) {
      throw new Error(`Unexpected web sender PIN: ${pin}`);
    }
    say(`the web sender's PIN is ${pin}`);

    const receiver = runCli(
      ['test', 'receive', '--output', outputDir],
      'CLI receiver',
    );
    receiver.child.stdin.write(`${pin}\n`);
    const confirmationCode = await waitForStdoutLine(
      receiver,
      (line) => CONFIRMATION_CODE.test(line),
      'receiver confirmation code',
    );
    say(`the CLI receiver's confirmation code is ${confirmationCode}`);

    const confirmationInput = page.getByRole('textbox', {
      name: 'Confirmation code',
    });
    await confirmationInput.waitFor({ state: 'visible', timeout: 60_000 });
    await confirmationInput.fill(confirmationCode);
    await page.getByRole('button', { name: 'Start transfer' }).click();

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

  const chromium = await loadChromium();
  const executablePath = await findBrowser();
  const server = await ensureWebServer(expectedWebPackage, REQUESTED_WEB_URL);
  webUrl = server.url;
  ownedWebServer = server.process;

  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  await warmQrWorker(browser);
  await warmWebApp(browser, webUrl, say);
  await cliToCli();
  await cliToWeb(browser);
  await webToCli(browser);
  console.log(`\nWEBRTC INTEROP LIVE TEST PASSED\nArtifacts: ${ARTIFACTS}`);
} catch (error) {
  console.error(
    `\nWEBRTC INTEROP LIVE TEST FAILED\n${(error as Error).stack ?? error}`,
  );
  console.error(`Artifacts: ${ARTIFACTS}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
