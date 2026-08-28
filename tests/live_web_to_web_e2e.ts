#!/usr/bin/env bun

// Live web ↔ web smoke test for pTransfer: a browser-tab sender
// transfers a file to a browser-tab receiver through the real Nostr relays
// and a real WebRTC data channel, driven headlessly via Playwright.
//
// Mirrors `live_webrtc_cli_interop.ts`, minus the CLI legs.
// It deliberately uses the public relays and therefore lives outside the unit
// test suite; it needs internet access, Bun, and a Chrome-family browser.
//
//   bun run test:live:web
//
// Environment:
//   PTRANSFER_WEB_URL                 reuse a running dev server (default
//                                   http://127.0.0.1:4173; started on a free
//                                   loopback port when absent or stale)
//   CHROME_PATH                     browser binary (default: known locations)
//   PTRANSFER_E2E_CACHE               playwright-core install cache
//   PTRANSFER_PLAYWRIGHT_VERSION      playwright-core version (default 1.55.0)

import type { ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSameBytes,
  ensureWebServer,
  findBrowser,
  instrumentPage,
  loadChromium,
  type PwBrowser,
  type PwLocator,
  type PwPage,
  readPackageIdentity,
  terminate,
  WEB_ROOT,
} from './support/live-harness.ts';

const REQUESTED_WEB_URL = new URL(
  process.env.PTRANSFER_WEB_URL ?? 'http://127.0.0.1:4173',
);
let webUrl = REQUESTED_WEB_URL;
const ARTIFACTS = await mkdtemp(join(tmpdir(), 'ptransfer-web-e2e-'));

let browser: PwBrowser | undefined;
let ownedWebServer: ChildProcess | undefined;
let cleanupStarted = false;

async function receivePasteInput(page: PwPage): Promise<PwLocator> {
  await page.getByRole('tab', { name: 'Paste', exact: true }).click();
  const input = page.getByRole('textbox', {
    name: 'PIN, onion address, or sender code',
    exact: true,
  });
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  return input;
}

async function warmWebApp(activeBrowser: PwBrowser): Promise<void> {
  console.log('[setup] warming browser dependency cache');
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  try {
    // The about page exercises the QR worker and its WASM dependency. On a
    // fresh Vite cache this can trigger dependency optimization and a full
    // browser reload, so wait for QR generation to succeed after that reload.
    await page.goto(new URL('/about', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    await page
      .getByRole('img', { name: 'Scan to open on mobile' })
      .waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForLoadState('networkidle');

    // Confirm both pages used by the scenario are fully loaded only after the
    // optimization reload. The isolated test contexts are created afterward,
    // so no in-memory transfer state can be lost to first-run cache warming.
    await page.goto(new URL('/receive', webUrl).href, {
      waitUntil: 'networkidle',
    });
    await receivePasteInput(page);

    await page.goto(new URL('/send', webUrl).href, {
      waitUntil: 'networkidle',
    });
    await page
      .locator('input[type="file"]')
      .first()
      .waitFor({ state: 'attached', timeout: 30_000 });
    console.log('[setup] browser dependency cache ready');
  } finally {
    await context.close();
  }
}

async function readWebConfirmationCode(page: PwPage): Promise<string> {
  await page.waitForFunction(
    () => /Confirmation code\s+[0-9A-Z]{4}-[0-9A-Z]{4}/.test(document.body.innerText),
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

async function webToWeb(activeBrowser: PwBrowser): Promise<void> {
  console.log('\n=== Web sender -> web receiver ===');
  // Isolated contexts: two independent tabs with no shared storage, exactly
  // like a sender and a receiver on different machines.
  const senderContext = await activeBrowser.newContext();
  const receiverContext = await activeBrowser.newContext({ acceptDownloads: true });
  const senderPage = await senderContext.newPage();
  const receiverPage = await receiverContext.newPage();
  const assertNoSenderErrors = instrumentPage(senderPage, 'web sender');
  const assertNoReceiverErrors = instrumentPage(receiverPage, 'web receiver');
  try {
    const source = join(WEB_ROOT, 'README.md');

    await senderPage.goto(new URL('/send', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    await senderPage.locator('input[type="file"]').first().setInputFiles(source);
    await senderPage
      .getByRole('button', { name: 'Start PIN Exchange' })
      .click();

    const pinInput = senderPage.getByRole('textbox', {
      name: 'PIN',
      exact: true,
    });
    await pinInput.waitFor({ state: 'visible', timeout: 120_000 });
    const pin = await pinInput.inputValue();
    if (pin.length !== 12) {
      throw new Error(`Unexpected web sender PIN: ${pin}`);
    }
    console.log(`[e2e] web sender PIN: ${pin}`);

    await receiverPage.goto(new URL('/receive', webUrl).href, {
      waitUntil: 'domcontentloaded',
    });
    const receiverInput = await receivePasteInput(receiverPage);
    await receiverInput.fill(pin);
    await receiverPage.getByRole('button', { name: 'Receive', exact: true }).click();

    const confirmationCode = await readWebConfirmationCode(receiverPage);
    console.log(`[e2e] web receiver confirmation code: ${confirmationCode}`);

    const confirmationInput = senderPage.getByRole('textbox', {
      name: 'Confirmation code',
    });
    await confirmationInput.waitFor({ state: 'visible', timeout: 60_000 });
    await confirmationInput.fill(confirmationCode);
    await senderPage.getByRole('button', { name: 'Start transfer' }).click();

    const downloadButton = receiverPage.getByRole('button', {
      name: 'Download File',
    });
    await downloadButton.waitFor({ state: 'visible', timeout: 150_000 });
    await senderPage.getByText('Transfer Complete!', { exact: true }).waitFor({
      state: 'visible',
      timeout: 60_000,
    });

    const downloadPromise = receiverPage.waitForEvent('download', {
      timeout: 30_000,
    });
    await downloadButton.click();
    const download = await downloadPromise;
    const downloaded = join(ARTIFACTS, 'web-to-web-README.md');
    await download.saveAs(downloaded);
    await assertSameBytes(source, downloaded, 'web -> web downloaded file');
    assertNoSenderErrors();
    assertNoReceiverErrors();
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
}

async function cleanup(): Promise<void> {
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;
  if (browser) {
    await browser.close().catch(() => {});
  }
  await terminate(ownedWebServer, true).catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

try {
  const expectedWebPackage = await readPackageIdentity();
  console.log(`[setup] pTransfer ${expectedWebPackage.version}`);
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

  await warmWebApp(browser);
  await webToWeb(browser);
  console.log(`\nWEB -> WEB LIVE TEST PASSED\nArtifacts: ${ARTIFACTS}`);
} catch (error) {
  console.error(`\nWEB -> WEB LIVE TEST FAILED\n${(error as Error).stack ?? error}`);
  console.error(`Artifacts: ${ARTIFACTS}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
