#!/usr/bin/env bun

// Live web ↔ web smoke test for pTransfer: a browser-tab sender
// transfers a file to a browser-tab receiver through the real Nostr relays
// and a real WebRTC data channel, driven headlessly via Playwright.
//
// Scenarios, in order:
//   typed-pin    English tabs; the PIN is typed into the receiver's box
//   pin-link-es  a Spanish sender; the receiver opens the link its PIN QR
//                holds, which names no /es/ path but carries `&l=es`, and
//                must land on the Spanish receive page with the PIN filled in
//
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
import {
  getLocale,
  type Locale,
  localizePath,
  setLocale,
  t,
} from '../src/lib/i18n.ts';
import { linkLocale } from '../src/lib/link-locale.ts';

const REQUESTED_WEB_URL = new URL(
  process.env.PTRANSFER_WEB_URL ?? 'http://127.0.0.1:4173',
);
let webUrl = REQUESTED_WEB_URL;
const ARTIFACTS = await mkdtemp(join(tmpdir(), 'ptransfer-web-e2e-'));

let browser: PwBrowser | undefined;
let ownedWebServer: ChildProcess | undefined;
let cleanupStarted = false;

/** The receive page's input box, in the current locale. */
function receiveInput(page: PwPage): PwLocator {
  return page.getByRole('textbox', {
    name: t({
      en: 'PIN, onion address, or sender code',
      es: 'PIN, dirección onion o código del emisor',
    }),
    exact: true,
  });
}

async function receivePasteInput(page: PwPage): Promise<PwLocator> {
  await page
    .getByRole('tab', { name: t({ en: 'Paste', es: 'Pegar' }), exact: true })
    .click();
  const input = receiveInput(page);
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  return input;
}

/** `path`, an app path such as `/send`, in the current locale. */
function pageUrl(path: string): string {
  return new URL(localizePath(path, getLocale()), webUrl).href;
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
  const label = t({ en: 'Confirmation code', es: 'Código de confirmación' });
  await page.waitForFunction(
    (shown) =>
      new RegExp(`${shown}\\s+[0-9A-Z]{4}-[0-9A-Z]{4}`).test(
        document.body.innerText,
      ),
    label,
    { timeout: 120_000 },
  );
  const text = await page.locator('body').innerText();
  const match = text.match(
    new RegExp(`${label}\\s+([0-9A-Z]{4})-([0-9A-Z]{4})`),
  );
  if (!match) {
    throw new Error('Web receiver confirmation code was not found');
  }
  return `${match[1]}${match[2]}`;
}

/**
 * A tab sends by PIN Exchange to another tab, both in `locale`; the receiver
 * either types the PIN or opens the link the sender's QR code holds.
 */
async function webToWeb(
  activeBrowser: PwBrowser,
  scenario: string,
  locale: Locale,
  viaLink: boolean,
): Promise<void> {
  console.log(`\n=== Web sender -> web receiver: ${scenario} ===`);
  // The labels the tabs are driven by are the pages' own, in their language.
  setLocale(locale);
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

    await senderPage.goto(pageUrl('/send'), { waitUntil: 'domcontentloaded' });
    await senderPage.locator('input[type="file"]').first().setInputFiles(source);
    await senderPage
      .getByRole('button', {
        name: t({
          en: 'Start PIN Exchange',
          es: 'Iniciar Intercambio por PIN',
        }),
      })
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

    if (viaLink) {
      const qr = senderPage.getByTestId('pin-link');
      await qr.waitFor({ state: 'visible', timeout: 60_000 });
      const link = new URL((await qr.getAttribute('data-link')) ?? '');
      console.log(`[e2e] web sender PIN link: ${link.href}`);
      // The link names the page, not its language's path: the language is
      // in the fragment, for the page to move to before it renders.
      if (link.pathname !== '/receive' || linkLocale(link.hash) !== locale) {
        throw new Error(`Unexpected ${locale} PIN link: ${link.href}`);
      }
      await receiverPage.goto(link.href, { waitUntil: 'domcontentloaded' });
      const receiverInput = receiveInput(receiverPage);
      await receiverInput.waitFor({ state: 'visible', timeout: 30_000 });
      const expectedPath = localizePath('/receive', locale);
      const landedOn = new URL(receiverPage.url()).pathname;
      const lang = await receiverPage.locator('html').getAttribute('lang');
      if (landedOn !== expectedPath || lang !== locale) {
        throw new Error(
          `The link opened ${landedOn} in ${lang}, not ${expectedPath} in ${locale}`,
        );
      }
      const filledIn = await receiverInput.inputValue();
      if (filledIn !== pin) {
        throw new Error(`The link filled in ${JSON.stringify(filledIn)}, not the PIN`);
      }
      console.log(`[e2e] the link opened ${landedOn} with the PIN filled in`);
    } else {
      await receiverPage.goto(pageUrl('/receive'), {
        waitUntil: 'domcontentloaded',
      });
      const receiverInput = await receivePasteInput(receiverPage);
      await receiverInput.fill(pin);
    }
    await receiverPage
      .getByRole('button', {
        name: t({ en: 'Receive', es: 'Recibir' }),
        exact: true,
      })
      .click();

    const confirmationCode = await readWebConfirmationCode(receiverPage);
    console.log(`[e2e] web receiver confirmation code: ${confirmationCode}`);

    const confirmationInput = senderPage.getByRole('textbox', {
      name: t({ en: 'Confirmation code', es: 'Código de confirmación' }),
    });
    await confirmationInput.waitFor({ state: 'visible', timeout: 60_000 });
    await confirmationInput.fill(confirmationCode);
    await senderPage
      .getByRole('button', {
        name: t({ en: 'Start transfer', es: 'Iniciar transferencia' }),
      })
      .click();

    const downloadButton = receiverPage.getByRole('button', {
      name: t({ en: 'Download File', es: 'Descargar archivo' }),
    });
    await downloadButton.waitFor({ state: 'visible', timeout: 150_000 });
    await senderPage
      .getByText(
        t({ en: 'Transfer Complete!', es: '¡Transferencia completada!' }),
        { exact: true },
      )
      .waitFor({ state: 'visible', timeout: 60_000 });

    const downloadPromise = receiverPage.waitForEvent('download', {
      timeout: 30_000,
    });
    await downloadButton.click();
    const download = await downloadPromise;
    const downloaded = join(ARTIFACTS, `${scenario}-README.md`);
    await download.saveAs(downloaded);
    await assertSameBytes(source, downloaded, `${scenario} downloaded file`);
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
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Headless Chrome hides host candidates behind mDNS names, which
      // nothing here resolves; the two tabs then never connect directly.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });

  await warmWebApp(browser);
  await webToWeb(browser, 'typed-pin', 'en', false);
  await webToWeb(browser, 'pin-link-es', 'es', true);
  console.log(`\nWEB -> WEB LIVE TEST PASSED\nArtifacts: ${ARTIFACTS}`);
} catch (error) {
  console.error(`\nWEB -> WEB LIVE TEST FAILED\n${(error as Error).stack ?? error}`);
  console.error(`Artifacts: ${ARTIFACTS}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
