#!/usr/bin/env bun

// Live Tor web-to-web test: one pTransfer tab publishes a v3 onion service and
// another fetches it, over real circuits.
//
// The CLI interop test covers each half of this against ptransfer-cli — a page
// serving a descriptor the CLI can fetch, and a page fetching one the CLI
// published — but never the two halves against each other. This is that
// pairing, and it runs two *separate browsers* by default, because that is how
// the mode is actually used: the peers do not share a profile, a directory
// cache, or a Tor client.
//
//   bun run test:live:tor:web
//
// Bootstrapping Tor over the public Snowflake bridge takes minutes per client,
// and this test bootstraps two. A local bridge makes the directory download
// local:
//
//   cd ../webtor-rs && scripts/local-bridge/bridge.sh start
//   eval "$(../webtor-rs/scripts/local-bridge/bridge.sh env)" && bun run test:live:tor:web
//
// Environment:
//   BRIDGE_URL, BRIDGE_FINGERPRINT  a Snowflake bridge for the browsers to use
//                                   instead of the public one; both or neither
//   TOR_TIMEOUT_MS                  how long a bootstrap/publish/rendezvous may
//                                   take (default 480000)
//   SAME_BROWSER=1                  run both peers in one browser, as two
//                                   contexts — two WASM Tor clients in a single
//                                   process, which the default run keeps apart
//   PTRANSFER_WEB_URL               reuse a running dev server
//   CHROME_PATH                     browser binary (default: known locations)

import type { ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSameBytes,
  ensureWebServer,
  findBrowser,
  instrumentPage,
  loadChromium,
  logPageConsole,
  type PwBrowser,
  type PwBrowserContext,
  type PwPage,
  readPackageIdentity,
  terminate,
  warmWebApp,
} from './support/live-harness.ts';

const REQUESTED_WEB_URL = new URL(
  process.env.PTRANSFER_WEB_URL ?? 'http://127.0.0.1:4174',
);
const BRIDGE_URL = process.env.BRIDGE_URL;
const BRIDGE_FINGERPRINT = process.env.BRIDGE_FINGERPRINT;
const SAME_BROWSER = process.env.SAME_BROWSER === '1';

/**
 * A Tor bootstrap, a descriptor publication and a rendezvous, back to back.
 * Generous by default and raisable, because the public bridge serves the
 * directory one hop away and a cold client can spend ten minutes on it.
 */
const TOR_TIMEOUT_MS = Number(process.env.TOR_TIMEOUT_MS ?? 8 * 60_000);

const ARTIFACTS = await mkdtemp(join(tmpdir(), 'ptransfer-tor-web-e2e-'));

let webUrl = REQUESTED_WEB_URL;
const browsers: PwBrowser[] = [];
let ownedWebServer: ChildProcess | undefined;
let cleanupStarted = false;

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (line: string) => console.log(`${elapsed().padStart(8)} ${line}`);

/** A small, compressible payload: the Tor transport carries at most 1 MiB. */
async function makePayload(name: string): Promise<string> {
  const path = join(ARTIFACTS, name);
  await writeFile(path, 'pTransfer over Tor, browser to browser.\n'.repeat(400));
  return path;
}

interface Peer {
  page: PwPage;
  context: PwBrowserContext;
  assertNoPageErrors: () => void;
}

async function openPeer(
  activeBrowser: PwBrowser,
  label: string,
  options: { acceptDownloads?: boolean } = {},
): Promise<Peer> {
  const context = await activeBrowser.newContext(options);
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, label);
  logPageConsole(page, label, say);
  return { page, context, assertNoPageErrors };
}

/** Publish an onion service from a tab and return the pair it shows. */
async function publishFromWeb(
  page: PwPage,
  source: string,
): Promise<{ address: string; password: string }> {
  await page.goto(new URL('/send', webUrl).href, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('input[type="file"]').first().setInputFiles(source);
  await page.getByRole('radio', { name: 'Tor Onion Service' }).click();
  await page.getByRole('button', { name: 'Publish Onion Service' }).click();

  const addressValue = page.getByTestId('tor-address');
  await addressValue.waitFor({ state: 'visible', timeout: TOR_TIMEOUT_MS });
  const address = (await addressValue.innerText()).trim();
  const password = (await page.getByTestId('tor-password').innerText()).trim();
  return { address, password };
}

/** Fetch that service from another tab and save what it delivers. */
async function receiveInWeb(
  page: PwPage,
  address: string,
  password: string,
  savedAs: string,
): Promise<void> {
  await page.goto(new URL('/receive', webUrl).href, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('tab', { name: 'Paste', exact: true }).click();

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
  await (await downloadPromise).saveAs(savedAs);
}

async function webToWeb(
  senderBrowser: PwBrowser,
  receiverBrowser: PwBrowser,
): Promise<void> {
  console.log('\n=== Web sender -> web receiver (Tor) ===');
  const source = await makePayload('web-to-web.txt');
  const sender = await openPeer(senderBrowser, 'web sender');
  const receiver = await openPeer(receiverBrowser, 'web receiver', {
    acceptDownloads: true,
  });

  try {
    const { address, password } = await publishFromWeb(sender.page, source);
    say(`the sending tab is serving at ${address}`);

    const downloaded = join(ARTIFACTS, 'web-to-web-downloaded.txt');
    await receiveInWeb(receiver.page, address, password, downloaded);

    // The sender only calls it complete once the receiver's ACK is in, so it
    // is the sending half of the same delivery the bytes below prove.
    await sender.page.getByText('Transfer Complete!', { exact: true }).waitFor({
      state: 'visible',
      timeout: 60_000,
    });

    await assertSameBytes(source, downloaded, 'web -> web downloaded file');
    sender.assertNoPageErrors();
    receiver.assertNoPageErrors();
  } finally {
    await receiver.context.close();
    await sender.context.close();
  }
}

async function cleanup(): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;
  for (const activeBrowser of browsers) {
    await activeBrowser.close().catch(() => {});
  }
  await terminate(ownedWebServer, true).catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

try {
  if (Boolean(BRIDGE_URL) !== Boolean(BRIDGE_FINGERPRINT)) {
    throw new Error(
      'Set BRIDGE_URL and BRIDGE_FINGERPRINT together, or neither',
    );
  }

  const expectedWebPackage = await readPackageIdentity();
  say(`pTransfer ${expectedWebPackage.version}`);
  say(`browser bridge: ${BRIDGE_URL ?? 'the public Snowflake bridge'}`);
  say(
    SAME_BROWSER
      ? 'both peers in one browser (SAME_BROWSER=1)'
      : 'each peer in its own browser',
  );

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

  const launch = async () => {
    const activeBrowser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    browsers.push(activeBrowser);
    await warmWebApp(activeBrowser, webUrl, say);
    return activeBrowser;
  };

  const senderBrowser = await launch();
  const receiverBrowser = SAME_BROWSER ? senderBrowser : await launch();

  await webToWeb(senderBrowser, receiverBrowser);
  console.log(`\nTOR WEB-TO-WEB LIVE TEST PASSED\nArtifacts: ${ARTIFACTS}`);
} catch (error) {
  console.error(
    `\nTOR WEB-TO-WEB LIVE TEST FAILED\n${(error as Error).stack ?? error}`,
  );
  console.error(`Artifacts: ${ARTIFACTS}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
