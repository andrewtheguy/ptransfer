#!/usr/bin/env bun

// Live web ↔ web smoke test for pTransfer: a browser-tab sender
// transfers a file to a browser-tab receiver through the real Nostr relays
// and a real WebRTC data channel, driven headlessly via Playwright.
//
// Mirrors ptransfer-cli's tests/live_interop_e2e.mjs, minus the CLI legs.
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

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Minimal structural views of the playwright-core API this script uses.
// playwright-core is installed at runtime into CACHE_ROOT rather than being a
// project dependency, so its own type declarations are not imported here.
interface PwLocator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  first(): PwLocator;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  setInputFiles(files: string): Promise<void>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
}

interface PwDownload {
  saveAs(path: string): Promise<void>;
}

interface PwPage {
  getByRole(
    role: string,
    options?: { name?: string; exact?: boolean },
  ): PwLocator;
  getByText(text: string, options?: { exact?: boolean }): PwLocator;
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  locator(selector: string): PwLocator;
  on(event: 'pageerror', handler: (error: Error) => void): void;
  waitForEvent(
    event: 'download',
    options?: { timeout?: number },
  ): Promise<PwDownload>;
  waitForFunction(
    fn: () => boolean,
    arg?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  waitForLoadState(state?: string): Promise<void>;
}

interface PwBrowserContext {
  close(): Promise<void>;
  newPage(): Promise<PwPage>;
}

interface PwBrowser {
  close(): Promise<void>;
  newContext(options?: { acceptDownloads?: boolean }): Promise<PwBrowserContext>;
}

interface PwBrowserType {
  launch(options?: {
    args?: string[];
    executablePath?: string;
    headless?: boolean;
  }): Promise<PwBrowser>;
}

interface PackageIdentity {
  name: string;
  version: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, '..');
const REQUESTED_WEB_URL = new URL(
  process.env.PTRANSFER_WEB_URL ?? 'http://127.0.0.1:4173',
);
let webUrl = REQUESTED_WEB_URL;
const CACHE_ROOT = resolve(
  process.env.PTRANSFER_E2E_CACHE
    ?? join(tmpdir(), 'ptransfer-web-live-e2e-cache'),
);
const PLAYWRIGHT_VERSION = process.env.PTRANSFER_PLAYWRIGHT_VERSION ?? '1.55.0';
const ARTIFACTS = await mkdtemp(join(tmpdir(), 'ptransfer-web-e2e-'));

let browser: PwBrowser | undefined;
let ownedWebServer: ChildProcess | undefined;
let cleanupStarted = false;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<void> {
  console.log(`[setup] ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await withTimeout(
      exit,
      options.timeoutMs ?? 10 * 60_000,
      `${command} setup command`,
    );
  } catch (error) {
    await terminate(child);
    throw error;
  }
  if (result.code !== 0) {
    throw new Error(
      `${command} exited with code ${result.code ?? 'null'}, signal ${result.signal ?? 'none'}`,
    );
  }
}

async function probeWebServer(
  url: URL,
  expectedPackageName: string,
): Promise<{ reachable: boolean; version: string | null }> {
  let reachable = false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    reachable = true;
    await response.body?.cancel();
    if (!response.ok) {
      return { reachable, version: null };
    }

    const packageResponse = await fetch(new URL('/package.json', url), {
      signal: AbortSignal.timeout(2_000),
    });
    if (!packageResponse.ok) {
      await packageResponse.body?.cancel();
      return { reachable, version: null };
    }
    const servedPackage = (await packageResponse.json()) as {
      name?: unknown;
      version?: unknown;
    };
    const version = servedPackage.name === expectedPackageName
      && typeof servedPackage.version === 'string'
      ? servedPackage.version
      : null;
    return { reachable, version };
  } catch {
    return { reachable, version: null };
  }
}

async function availableLoopbackUrl(): Promise<URL> {
  const port = await new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate an isolated web-server port'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolvePromise(address.port);
        }
      });
    });
  });
  return new URL(`http://127.0.0.1:${port}`);
}

async function ensureWebServer(expectedPackage: PackageIdentity): Promise<void> {
  const existing = await probeWebServer(
    REQUESTED_WEB_URL,
    expectedPackage.name,
  );
  if (existing.version === expectedPackage.version) {
    webUrl = REQUESTED_WEB_URL;
    console.log(
      `[setup] using verified pTransfer ${existing.version} at ${webUrl.origin}`,
    );
    return;
  }

  if (existing.reachable) {
    console.log(
      `[setup] not reusing ${REQUESTED_WEB_URL.origin}: expected pTransfer `
      + `${expectedPackage.version}, found ${existing.version ?? 'an unverified response'}`,
    );
  }
  await access(join(WEB_ROOT, 'node_modules', '.bin', 'vite'), fsConstants.X_OK).catch(() => {
    throw new Error(`Missing web dependencies; run bun install in ${WEB_ROOT}`);
  });

  const requestedIsAvailableLoopback = !existing.reachable
    && REQUESTED_WEB_URL.protocol === 'http:'
    && ['127.0.0.1', 'localhost'].includes(REQUESTED_WEB_URL.hostname);
  webUrl = requestedIsAvailableLoopback
    ? REQUESTED_WEB_URL
    : await availableLoopbackUrl();

  const port = webUrl.port || '80';
  console.log(`[setup] starting pTransfer ${expectedPackage.version} at ${webUrl.origin}`);
  ownedWebServer = spawn(
    'bun',
    [
      'run',
      'dev',
      '--',
      '--host',
      webUrl.hostname,
      '--port',
      port,
      '--strictPort',
    ],
    {
      cwd: WEB_ROOT,
      detached: true,
      env: process.env,
      stdio: 'inherit',
    },
  );
  ownedWebServer.once('error', (error) => {
    console.error(`[web] ${error.stack ?? error}`);
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (ownedWebServer.exitCode !== null || ownedWebServer.signalCode !== null) {
      throw new Error('pTransfer exited before becoming ready');
    }
    const probe = await probeWebServer(webUrl, expectedPackage.name);
    if (probe.version === expectedPackage.version) {
      return;
    }
    await sleep(250);
  }
  throw new Error(
    `pTransfer ${expectedPackage.version} did not become ready at ${webUrl.origin}`,
  );
}

async function loadChromium(): Promise<PwBrowserType> {
  const playwrightEntry = join(
    CACHE_ROOT,
    'node_modules',
    'playwright-core',
    'index.mjs',
  );
  try {
    await access(playwrightEntry, fsConstants.R_OK);
  } catch {
    await mkdir(CACHE_ROOT, { recursive: true });
    await runCommand(
      'bun',
      [
        'install',
        '--no-save',
        '--cwd',
        CACHE_ROOT,
        `playwright-core@${PLAYWRIGHT_VERSION}`,
      ],
    );
  }
  const playwright = (await import(pathToFileURL(playwrightEntry).href)) as {
    chromium: PwBrowserType;
  };
  return playwright.chromium;
}

async function findBrowser(): Promise<string> {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.PROGRAMFILES;
  const programFilesX86 = process.env['PROGRAMFILES(X86)'];
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    localAppData
      ? join(localAppData, 'Google/Chrome/Application/chrome.exe')
      : undefined,
    programFiles
      ? join(programFiles, 'Google/Chrome/Application/chrome.exe')
      : undefined,
    programFilesX86
      ? join(programFilesX86, 'Google/Chrome/Application/chrome.exe')
      : undefined,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next known browser path.
    }
  }
  throw new Error(
    `No Chrome-family browser found; set CHROME_PATH (checked ${candidates.join(', ')})`,
  );
}

function instrumentPage(page: PwPage, label: string): () => void {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error);
    console.error(`[${label}:pageerror] ${error.stack ?? error}`);
  });
  return () => {
    if (pageErrors.length > 0) {
      throw new Error(`${label}: browser page raised ${pageErrors.length} error(s)`);
    }
  };
}

async function receivePasteInput(page: PwPage): Promise<PwLocator> {
  await page.getByRole('tab', { name: 'Paste', exact: true }).click();
  const input = page.getByRole('textbox', {
    name: 'PIN or sender code',
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

async function assertSameBytes(
  expectedPath: string,
  actualPath: string,
  label: string,
): Promise<void> {
  const [expected, actual] = await Promise.all([
    readFile(expectedPath),
    readFile(actualPath),
  ]);
  if (!expected.equals(actual)) {
    throw new Error(
      `${label}: byte mismatch (${expected.length} expected, ${actual.length} actual)`,
    );
  }
  const digest = createHash('sha256').update(actual).digest('hex');
  console.log(`[PASS] ${label}: ${actual.length} bytes, sha256 ${digest}`);
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

async function terminate(
  child: ChildProcess | undefined,
  processGroup = false,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      if (processGroup && child.pid !== undefined) {
        process.kill(-child.pid, name);
      } else {
        child.kill(name);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  };
  signal('SIGTERM');
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  try {
    await withTimeout(exited, 5_000, 'child process shutdown');
  } catch {
    signal('SIGKILL');
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
  const expectedWebPackage = JSON.parse(
    await readFile(join(WEB_ROOT, 'package.json'), 'utf8'),
  ) as PackageIdentity;
  console.log(`[setup] pTransfer ${expectedWebPackage.version}`);
  const chromium = await loadChromium();
  const executablePath = await findBrowser();
  await ensureWebServer(expectedWebPackage);
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
