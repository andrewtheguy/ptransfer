#!/usr/bin/env bun

// Live Code Exchange test between the CLI and a browser tab: the two ends of
// one transfer are a terminal and a page, both running `src/lib`, with the
// codes carried as the text the tab's "Show text to copy manually" gives and
// the CLI prints — what a person moving them by copy and paste does. One
// scenario is PIN Exchange instead, for the link a tab hands to a terminal.
//
//   bun run test:live:code:cli-web
//
// Scenarios, in order:
//   web-to-cli        a tab sends, the CLI receives, over a direct connection
//   cli-to-web        the CLI sends, a tab receives, over a direct connection
//   web-to-cli-relay  a tab sends, the CLI receives simulating no direct
//                     route, so the file goes through public Nostr relays
//   cli-to-web-relay  the CLI sends, a tab receives with its own "Simulate
//                     no direct connection", through public Nostr relays
//   web-to-cli-pin-link
//                     a tab sends by PIN Exchange, and the CLI receives from
//                     the link its QR code holds — with `&l=es` on it when
//                     the tab is in Spanish — the way a person pastes a
//                     scanned link into a terminal
//   web-to-cli-anonymous
//                     a tab sends with Anonymous signaling and relay on, the
//                     CLI receives simulating no direct route, so the file
//                     goes through Tor; a fresh tab bootstraps Tor cold, so
//                     this takes minutes and runs only when asked for
//
// Environment:
//   SCENARIOS           comma-separated scenarios to run (default: all but
//                       the anonymous one)
//   UI_LANG             the language both ends speak, `en` (default) or `es`:
//                       the tab opens the `/es/` pages and is driven by their
//                       Spanish labels, and the CLI runs with `--lang es`
//   TIMEOUT_MS          how long each transfer may take (default 300000)
//   PTRANSFER_WEB_URL   reuse a running dev server
//   CHROME_PATH         browser binary (default: known locations)

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  assertSameBytes,
  ensureWebServer,
  findBrowser,
  instrumentPage,
  loadChromium,
  type PwBrowser,
  type PwPage,
  readPackageIdentity,
  sleep,
  terminate,
  WEB_ROOT,
  warmWebApp,
  withTimeout,
} from './support/live-harness.ts';
import {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  localizePath,
  setLocale,
  t,
} from '../src/lib/i18n.ts';
import { linkLocale } from '../src/lib/link-locale.ts';

const DEFAULT_SCENARIOS = [
  'web-to-cli',
  'cli-to-web',
  'web-to-cli-relay',
  'cli-to-web-relay',
  'web-to-cli-pin-link',
];
const KNOWN_SCENARIOS = [...DEFAULT_SCENARIOS, 'web-to-cli-anonymous'];
const SCENARIOS = new Set(
  (process.env.SCENARIOS ?? DEFAULT_SCENARIOS.join(','))
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
const REQUESTED_LANG = process.env.UI_LANG ?? 'en';
if (!isLocale(REQUESTED_LANG)) {
  throw new Error(
    `UI_LANG must be en or es, not ${JSON.stringify(REQUESTED_LANG)}`,
  );
}
const UI_LANG: Locale = REQUESTED_LANG;
// The labels the tab is driven by are the page's own, in its language.
setLocale(UI_LANG);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 5 * 60_000);
const REQUESTED_WEB_URL = new URL(
  process.env.PTRANSFER_WEB_URL ?? 'http://127.0.0.1:4173',
);

const ARTIFACTS = await mkdtemp(join(tmpdir(), 'ptransfer-code-cli-web-e2e-'));
const children: ChildProcess[] = [];
let browser: PwBrowser | undefined;
let ownedWebServer: ChildProcess | undefined;

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (line: string) => console.log(`${elapsed().padStart(8)} ${line}`);

interface Cli {
  child: ChildProcess;
  /** The first line the process writes to standard output: its code. */
  code: Promise<string>;
  /** The last line it wrote to standard output, once it has exited 0. */
  result: Promise<string>;
}

/** One CLI process, its output relayed line by line. */
function runCli(label: string, args: string[], cwd = WEB_ROOT): Cli {
  // `--lang` always, so the person running this gets the language asked for
  // whatever their own environment's locale is.
  const cliArgs = [join(WEB_ROOT, 'cli', 'main.ts'), '--lang', UI_LANG, ...args];
  const child = spawn('bun', cliArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let resolveCode: (line: string) => void = () => {};
  const firstLine = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => {
    stdout += text;
    const newline = stdout.indexOf('\n');
    if (newline >= 0) resolveCode(stdout.slice(0, newline));
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text: string) => {
    for (const line of text.split('\n')) if (line) say(`[${label}] ${line}`);
  });
  const exited = new Promise<number>((resolve) =>
    child.once('close', (code) => resolve(code ?? -1)),
  );
  const failed = exited.then((status) => {
    throw new Error(`the ${label} exited with status ${status}`);
  });
  void failed.catch(() => {});
  return {
    child,
    code: Promise.race([firstLine, failed]),
    result: exited.then((status) => {
      if (status !== 0) throw new Error(`the ${label} exited with status ${status}`);
      return stdout.trim().split('\n').pop() ?? '';
    }),
  };
}

/** The code a page shows under "Show text to copy manually". */
async function copiedText(page: PwPage, label: string): Promise<string> {
  // A substring: a page that cannot copy asks "Can't copy? Show text…".
  const reveal = page.getByRole('button', {
    name: t({
      en: 'Show text to copy manually',
      es: 'Mostrar el texto para copiarlo a mano',
    }),
  });
  await reveal.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await reveal.click();
  const text = page.getByRole('textbox', { name: label, exact: true });
  await text.waitFor({ state: 'visible', timeout: 30_000 });
  return (await text.inputValue()).trim();
}

async function makePayload(name: string, bytes: number): Promise<string> {
  const path = join(ARTIFACTS, name);
  await writeFile(path, crypto.getRandomValues(new Uint8Array(bytes)));
  return path;
}

/** `path`, an app path such as `/send`, on the server in the test's language. */
function pageUrl(path: string): string {
  return new URL(localizePath(path, UI_LANG), webUrl).href;
}

/** A tab sends by Code Exchange; `ptransfer receive --code` takes it. */
async function webToCli(
  activeBrowser: PwBrowser,
  relay: boolean,
  anonymous = false,
): Promise<void> {
  const scenario = anonymous
    ? 'web-to-cli-anonymous'
    : relay
      ? 'web-to-cli-relay'
      : 'web-to-cli';
  console.log(`\n=== ${scenario} ===`);
  const source = await makePayload(`${scenario}.bin`, relay ? 500_000 : 2_000_000);
  const inbox = join(ARTIFACTS, `inbox-${scenario}`);
  await mkdir(inbox);
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web sender');
  try {
    await page.goto(pageUrl('/send'), { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"]').first().setInputFiles(source);
    await page.locator('#send-mode-code').click();
    if (anonymous) {
      await page
        .getByText(t({ en: 'Advanced options', es: 'Opciones avanzadas' }), {
          exact: true,
        })
        .click();
      await page.locator('#send-anonymous-relay').click();
    }
    await page
      .getByRole('button', {
        name: t({
          en: 'Start Code Exchange',
          es: 'Iniciar Intercambio por código',
        }),
      })
      .click();
    const offer = await copiedText(
      page,
      t({ en: 'Connection data to copy', es: 'Datos de conexión para copiar' }),
    );
    say(`the tab's code is ${offer.length} characters`);

    const receiver = runCli(
      'cli receiver',
      ['receive', '--code', ...(relay ? ['--simulate-no-direct'] : [])],
      inbox,
    );
    receiver.child.stdin?.write(`${offer}\n`);
    const answer = await withTimeout(receiver.code, TIMEOUT_MS, "the CLI's response");
    say(`the CLI's response is ${answer.length} characters`);

    await page
      .getByRole('tab', { name: t({ en: 'Paste', es: 'Pegar' }), exact: true })
      .click();
    await page
      .getByRole('textbox', {
        name: t({
          en: "Receiver's response code",
          es: 'Código de respuesta del receptor',
        }),
        exact: true,
      })
      .fill(answer);
    await page
      .getByRole('button', {
        name: t({ en: 'Submit', es: 'Confirmar' }),
        exact: true,
      })
      .click();

    const saved = await withTimeout(receiver.result, TIMEOUT_MS, 'the CLI to save the file');
    try {
      await page
        .getByText(
          t({ en: 'Transfer Complete!', es: '¡Transferencia completada!' }),
          { exact: true },
        )
        .waitFor({ state: 'visible', timeout: 60_000 });
    } catch (error) {
      const shown = await page.locator('body').innerText();
      say(`the tab never finished; it shows:\n${shown}`);
      throw error;
    }
    if (basename(saved) !== `${scenario}.bin`) {
      throw new Error(`the CLI saved an unexpected name: ${saved}`);
    }
    await assertSameBytes(source, saved, `${scenario} received file`);
    assertNoPageErrors();
  } finally {
    await context.close();
  }
}

/**
 * A tab sends by PIN Exchange; `ptransfer receive --pin` takes the link the
 * tab's QR code holds, and the tab takes the confirmation code it prints.
 */
async function webToCliPinLink(activeBrowser: PwBrowser): Promise<void> {
  const scenario = 'web-to-cli-pin-link';
  console.log(`\n=== ${scenario} ===`);
  const source = await makePayload(`${scenario}.bin`, 500_000);
  const inbox = join(ARTIFACTS, `inbox-${scenario}`);
  await mkdir(inbox);
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web sender');
  try {
    await page.goto(pageUrl('/send'), { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"]').first().setInputFiles(source);
    await page
      .getByRole('button', {
        name: t({
          en: 'Start PIN Exchange',
          es: 'Iniciar Intercambio por PIN',
        }),
      })
      .click();
    const qr = page.getByTestId('pin-link');
    await qr.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const link = (await qr.getAttribute('data-link')) ?? '';
    say(`the tab's PIN link is ${link}`);
    // An English link names no language; a Spanish one names Spanish.
    const named = linkLocale(new URL(link).hash);
    if (named !== (UI_LANG === DEFAULT_LOCALE ? undefined : UI_LANG)) {
      throw new Error(`the ${UI_LANG} tab's link names ${named ?? 'no language'}`);
    }

    const receiver = runCli('cli receiver', ['receive', '--pin'], inbox);
    receiver.child.stdin?.write(`${link}\n`);
    // `confirmation: <code>`: a label, then the code to read back.
    const line = await withTimeout(
      receiver.code,
      TIMEOUT_MS,
      "the CLI's confirmation code",
    );
    const confirmation = line.slice(line.indexOf(': ') + 2).trim();
    say(`the CLI's confirmation code is ${confirmation}`);

    await page
      .getByRole('textbox', {
        name: t({ en: 'Confirmation code', es: 'Código de confirmación' }),
        exact: true,
      })
      .fill(confirmation);
    await page
      .getByRole('button', {
        name: t({ en: 'Start transfer', es: 'Iniciar transferencia' }),
      })
      .click();

    const saved = await withTimeout(receiver.result, TIMEOUT_MS, 'the CLI to save the file');
    await page
      .getByText(
        t({ en: 'Transfer Complete!', es: '¡Transferencia completada!' }),
        { exact: true },
      )
      .waitFor({ state: 'visible', timeout: 60_000 });
    if (basename(saved) !== `${scenario}.bin`) {
      throw new Error(`the CLI saved an unexpected name: ${saved}`);
    }
    await assertSameBytes(source, saved, `${scenario} received file`);
    assertNoPageErrors();
  } finally {
    await context.close();
  }
}

/** `ptransfer send --code` sends; a tab takes it. */
async function cliToWeb(activeBrowser: PwBrowser, relay: boolean): Promise<void> {
  const scenario = relay ? 'cli-to-web-relay' : 'cli-to-web';
  console.log(`\n=== ${scenario} ===`);
  const source = await makePayload(`${scenario}.bin`, relay ? 500_000 : 2_000_000);
  const context = await activeBrowser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const assertNoPageErrors = instrumentPage(page, 'web receiver');
  try {
    const sender = runCli('cli sender', ['send', '--code', source]);
    const offer = await withTimeout(sender.code, TIMEOUT_MS, "the CLI's code");
    say(`the CLI's code is ${offer.length} characters`);

    await page.goto(pageUrl('/receive'), { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('tab', { name: t({ en: 'Paste', es: 'Pegar' }), exact: true })
      .click();
    await page
      .getByRole('textbox', {
        name: t({
          en: 'PIN, onion address, or sender code',
          es: 'PIN, dirección onion o código del emisor',
        }),
        exact: true,
      })
      .fill(offer);
    await page
      .getByRole('button', {
        name: t({ en: 'Receive', es: 'Recibir' }),
        exact: true,
      })
      .click();
    const responseLabel = t({
      en: 'Response data to copy',
      es: 'Datos de respuesta para copiar',
    });
    let answer = await copiedText(page, responseLabel);
    if (relay) {
      await page
        .getByText(t({ en: 'Advanced options', es: 'Opciones avanzadas' }), {
          exact: true,
        })
        .click();
      await page
        .getByRole('button', {
          name: t({
            en: 'Simulate no direct connection',
            es: 'Simular que no hay conexión directa',
          }),
        })
        .click();
      await page
        .getByRole('button', {
          name: t({
            en: 'Go back to a direct connection',
            es: 'Volver a una conexión directa',
          }),
        })
        .waitFor({ state: 'visible', timeout: 30_000 });
      // The response is built again with no routes in it; wait for it.
      const text = page.getByRole('textbox', {
        name: responseLabel,
        exact: true,
      });
      const direct = answer;
      const deadline = Date.now() + 30_000;
      while (answer === direct) {
        if (Date.now() > deadline) {
          throw new Error('the tab never showed a response without routes');
        }
        await sleep(250);
        answer = (await text.inputValue()).trim();
      }
    }
    say(`the tab's response is ${answer.length} characters`);
    sender.child.stdin?.write(`${answer}\n`);

    const downloadButton = page.getByRole('button', {
      name: t({ en: 'Download File', es: 'Descargar archivo' }),
    });
    await downloadButton.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;
    const downloaded = join(ARTIFACTS, `downloaded-${scenario}.bin`);
    await download.saveAs(downloaded);
    await withTimeout(sender.result, TIMEOUT_MS, 'the CLI sender to finish');
    await assertSameBytes(source, downloaded, `${scenario} downloaded file`);
    assertNoPageErrors();
  } finally {
    await context.close();
  }
}

let webUrl = REQUESTED_WEB_URL;

async function cleanup(): Promise<void> {
  for (const child of children) await terminate(child).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await terminate(ownedWebServer, true).catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

try {
  const chromium = await loadChromium();
  const executablePath = await findBrowser();
  const server = await ensureWebServer(await readPackageIdentity(), REQUESTED_WEB_URL);
  webUrl = server.url;
  ownedWebServer = server.process;
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Headless Chrome hides host candidates behind mDNS names, which
      // nothing here resolves; the tab and the CLI then never connect
      // directly.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
  await warmWebApp(browser, webUrl, say);
  say(`both ends speak ${UI_LANG}`);

  if (SCENARIOS.has('web-to-cli')) await webToCli(browser, false);
  if (SCENARIOS.has('cli-to-web')) await cliToWeb(browser, false);
  if (SCENARIOS.has('web-to-cli-relay')) await webToCli(browser, true);
  if (SCENARIOS.has('cli-to-web-relay')) await cliToWeb(browser, true);
  if (SCENARIOS.has('web-to-cli-pin-link')) await webToCliPinLink(browser);
  if (SCENARIOS.has('web-to-cli-anonymous')) {
    await webToCli(browser, true, true);
  }
  console.log(
    `\nAll Code Exchange CLI <-> web transfers (${UI_LANG}) passed in ${elapsed()}.`,
  );
} catch (error) {
  console.error(`\n[FAIL] ${(error as Error).stack ?? error}`);
  console.error(`Artifacts: ${ARTIFACTS}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
