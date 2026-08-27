#!/usr/bin/env bun

// Live Tor interoperability test: a pTransfer browser tab and ptransfer-cli
// transferring a file to each other over a v3 onion service, in both
// directions, driven headlessly via Playwright.
//
//   cli -> web   the CLI publishes a service with `ptransfer tor send`; the
//                page pastes the address, enters the password, and downloads
//   web -> cli   the page publishes a service of its own; the CLI fetches it
//                with `ptransfer tor receive`
//
// A failure therefore names the side that is wrong rather than just "Tor
// transfers do not work". Nothing here is mocked: real circuits, real
// introduction points, real descriptors.
//
//   bun run test:live:tor
//
// The CLI must be built with the `tor` feature:
//
//   cd ../ptransfer-cli && cargo build --release --all-features
//
// Bootstrapping Tor over the public Snowflake bridge takes minutes per client,
// because the browser fetches the consensus and every HSDir microdescriptor one
// hop from the bridge. A local bridge makes that download local:
//
//   cd ../webtor-rs && scripts/local-bridge/bridge.sh start
//   eval "$(../webtor-rs/scripts/local-bridge/bridge.sh env)" && bun run test:live:tor
//
// Environment:
//   PTRANSFER_BIN                   the CLI to drive (default
//                                   ../ptransfer-cli/target/release/ptransfer)
//   BRIDGE_URL, BRIDGE_FINGERPRINT  a Snowflake bridge for the browser to use
//                                   instead of the public one; both or neither
//   ONLY                            "cli-to-web" or "web-to-cli" for one leg
//   PTRANSFER_WEB_URL               reuse a running dev server
//   CHROME_PATH                     browser binary (default: known locations)

import { type ChildProcess, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  sleep,
  terminate,
  warmWebApp,
  WEB_ROOT,
} from './support/live-harness.ts';

const CLI = resolve(
  process.env.PTRANSFER_BIN ??
    join(WEB_ROOT, '..', 'ptransfer-cli', 'target', 'release', 'ptransfer'),
);
const REQUESTED_WEB_URL = new URL(
  process.env.PTRANSFER_WEB_URL ?? 'http://127.0.0.1:4173',
);
const ONLY = process.env.ONLY ?? '';
const BRIDGE_URL = process.env.BRIDGE_URL;
const BRIDGE_FINGERPRINT = process.env.BRIDGE_FINGERPRINT;

/** A Tor bootstrap, a descriptor publication and a rendezvous, back to back. */
const TOR_TIMEOUT_MS = 8 * 60_000;

const ARTIFACTS = await mkdtemp(join(tmpdir(), 'ptransfer-tor-e2e-'));

let webUrl = REQUESTED_WEB_URL;
let browser: PwBrowser | undefined;
let ownedWebServer: ChildProcess | undefined;
const runningCli = new Set<ChildProcess>();
let cleanupStarted = false;

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (line: string) => console.log(`${elapsed().padStart(8)} ${line}`);

/** Run the CLI, streaming its output to the console and to a collector. */
function runCli(args: string[], label: string, stdin?: string) {
  const child = spawn(CLI, args, {
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  runningCli.add(child);
  child.once('exit', () => runningCli.delete(child));
  if (stdin !== undefined) {
    child.stdin?.end(stdin);
  }

  const lines: string[] = [];
  for (const source of [child.stdout, child.stderr]) {
    source?.setEncoding('utf8');
    let pending = '';
    source?.on('data', (chunk: string) => {
      pending += chunk;
      let split = pending.indexOf('\n');
      while (split >= 0) {
        const line = pending.slice(0, split);
        pending = pending.slice(split + 1);
        lines.push(line);
        say(`[${label}] ${line}`);
        split = pending.indexOf('\n');
      }
    });
  }
  return { child, lines };
}

async function waitForLine(
  lines: string[],
  child: ChildProcess,
  predicate: (line: string) => boolean,
  what: string,
): Promise<string> {
  const deadline = Date.now() + TOR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = lines.find(predicate);
    if (found !== undefined) return found;
    if (child.exitCode !== null) {
      throw new Error(`${what}: the CLI exited with code ${child.exitCode}`);
    }
    await sleep(250);
  }
  throw new Error(`${what}: nothing after ${TOR_TIMEOUT_MS / 1000}s`);
}

async function waitForExit(child: ChildProcess, what: string): Promise<void> {
  const deadline = Date.now() + TOR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      if (child.exitCode !== 0) {
        throw new Error(`${what}: the CLI exited with code ${child.exitCode}`);
      }
      return;
    }
    await sleep(250);
  }
  throw new Error(`${what}: still running after ${TOR_TIMEOUT_MS / 1000}s`);
}

function requireMatch(
  lines: string[],
  pattern: RegExp,
  what: string,
): string {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  throw new Error(`${what}: not found in the CLI output`);
}

/** A small, compressible payload: the Tor transport carries at most 1 MiB. */
async function makePayload(name: string): Promise<string> {
  const path = join(ARTIFACTS, name);
  await writeFile(path, 'pTransfer over Tor, line after line.\n'.repeat(400));
  return path;
}

async function openReceivePage(page: PwPage): Promise<void> {
  await page.goto(new URL('/receive', webUrl).href, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('tab', { name: 'Paste', exact: true }).click();
}

/** The CLI publishes an onion service; the page connects and downloads. */
async function cliToWeb(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== CLI sender -> web receiver (Tor) ===');
  const source = await makePayload('cli-to-web.txt');
  const { child, lines } = runCli(['tor', 'send', source], 'tor send');

  const context = await activeBrowser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web receiver');
  logPageConsole(page, 'web receiver', say);
  try {
    await waitForLine(
      lines,
      child,
      (line) => line.trim() === 'ready',
      'the CLI never published its descriptor',
    );
    const address = requireMatch(
      lines,
      /address:\s+(\S+)/,
      'the CLI printed no address',
    );
    const password = requireMatch(
      lines,
      /password:\s+(\S+)/,
      'the CLI printed no password',
    );
    say(`the CLI is serving at ${address}`);

    await openReceivePage(page);
    const input = page.getByRole('textbox', {
      name: 'PIN, onion address, or sender code',
      exact: true,
    });
    await input.waitFor({ state: 'visible', timeout: 30_000 });
    await input.fill(address);
    await page.getByRole('button', { name: 'Receive', exact: true }).click();

    const passwordInput = page.getByRole('textbox', {
      name: 'One-time password',
    });
    await passwordInput.waitFor({ state: 'visible', timeout: 30_000 });
    await passwordInput.fill(password);
    await page.getByRole('button', { name: 'Connect over Tor' }).click();

    const downloadButton = page.getByRole('button', { name: 'Download File' });
    await downloadButton.waitFor({ state: 'visible', timeout: TOR_TIMEOUT_MS });

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const downloaded = join(ARTIFACTS, 'cli-to-web-downloaded.txt');
    await (await downloadPromise).saveAs(downloaded);
    await assertSameBytes(source, downloaded, 'cli -> web downloaded file');
    assertNoPageErrors();
  } finally {
    await terminate(child);
    await context.close();
  }
}

/** The page publishes an onion service; the CLI connects and saves the file. */
async function webToCli(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== Web sender -> CLI receiver (Tor) ===');
  const source = await makePayload('web-to-cli.txt');
  const output = join(ARTIFACTS, 'cli-output');
  await mkdir(output, { recursive: true });

  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web sender');
  logPageConsole(page, 'web sender', say);
  try {
    await page.goto(new URL('/send', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('input[type="file"]').first().setInputFiles(source);
    await page.getByRole('radio', { name: 'Tor Onion Service' }).click();
    await page.getByRole('button', { name: 'Publish Onion Service' }).click();

    const addressValue = page.getByTestId('tor-address');
    await addressValue.waitFor({ state: 'visible', timeout: TOR_TIMEOUT_MS });
    const address = (await addressValue.innerText()).trim();
    const password = (
      await page.getByTestId('tor-password').innerText()
    ).trim();
    say(`the page is serving at ${address}`);

    const { child, lines } = runCli(
      ['tor', 'receive', address, '--output', output, '--overwrite'],
      'tor receive',
      `${password}\n`,
    );
    try {
      await waitForExit(child, 'the CLI never finished receiving');
    } finally {
      await terminate(child);
    }
    if (!lines.some((line) => line.includes('Saved to'))) {
      throw new Error('the CLI never reported saving the file');
    }

    await page.getByText('Transfer Complete!', { exact: true }).waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    await assertSameBytes(
      source,
      join(output, 'web-to-cli.txt'),
      'web -> cli received file',
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
  if (Boolean(BRIDGE_URL) !== Boolean(BRIDGE_FINGERPRINT)) {
    throw new Error('Set BRIDGE_URL and BRIDGE_FINGERPRINT together, or neither');
  }
  await access(CLI, fsConstants.X_OK).catch(() => {
    throw new Error(
      `No ptransfer binary at ${CLI}; build it with ` +
        '`cargo build --release --all-features` or set PTRANSFER_BIN',
    );
  });

  const expectedWebPackage = await readPackageIdentity();
  say(`pTransfer ${expectedWebPackage.version}, CLI at ${CLI}`);
  if (BRIDGE_URL) say(`browser bridge: ${BRIDGE_URL}`);

  const chromium = await loadChromium();
  const executablePath = await findBrowser();
  // The dev server, not this process, is what has to see the bridge settings:
  // they reach the page as build-time `import.meta.env` values.
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
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  await warmWebApp(browser, webUrl, say);
  if (ONLY !== 'web-to-cli') await cliToWeb(browser);
  if (ONLY !== 'cli-to-web') await webToCli(browser);
  console.log(`\nTOR INTEROP LIVE TEST PASSED\nArtifacts: ${ARTIFACTS}`);
} catch (error) {
  console.error(
    `\nTOR INTEROP LIVE TEST FAILED\n${(error as Error).stack ?? error}`,
  );
  console.error(`Artifacts: ${ARTIFACTS}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
