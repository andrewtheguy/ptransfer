#!/usr/bin/env bun

// Live Code Exchange test between the CLI and a browser tab: the two ends of
// one transfer are a terminal and a page, both running `src/lib`, with the
// codes carried as the text the tab's "Show text to copy manually" gives and
// the CLI prints — what a person moving them by copy and paste does.
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
//   web-to-cli-anonymous
//                     a tab sends with Anonymous signaling and relay on, the
//                     CLI receives simulating no direct route, so the file
//                     goes through Tor; a fresh tab bootstraps Tor cold, so
//                     this takes minutes and runs only when asked for
//
// Environment:
//   SCENARIOS           comma-separated scenarios to run (default: the first
//                       four)
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

const DEFAULT_SCENARIOS = [
  'web-to-cli',
  'cli-to-web',
  'web-to-cli-relay',
  'cli-to-web-relay',
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
  const child = spawn('bun', [join(WEB_ROOT, 'cli', 'main.ts'), ...args], {
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
  const reveal = page.getByRole('button', {
    name: /Show text to copy manually/,
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
    await page.goto(new URL('/send', webUrl).href, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"]').first().setInputFiles(source);
    await page.locator('#send-mode-code').click();
    if (anonymous) {
      await page.getByText('Advanced options', { exact: true }).click();
      await page.locator('#send-anonymous-relay').click();
    }
    await page.getByRole('button', { name: 'Start Code Exchange' }).click();
    const offer = await copiedText(page, 'Connection data to copy');
    say(`the tab's code is ${offer.length} characters`);

    const receiver = runCli(
      'cli receiver',
      ['receive', '--code', ...(relay ? ['--simulate-no-direct'] : [])],
      inbox,
    );
    receiver.child.stdin?.write(`${offer}\n`);
    const answer = await withTimeout(receiver.code, TIMEOUT_MS, "the CLI's response");
    say(`the CLI's response is ${answer.length} characters`);

    await page.getByRole('tab', { name: 'Paste', exact: true }).click();
    await page
      .getByRole('textbox', { name: "Receiver's response code", exact: true })
      .fill(answer);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();

    const saved = await withTimeout(receiver.result, TIMEOUT_MS, 'the CLI to save the file');
    try {
      await page
        .getByText('Transfer Complete!', { exact: true })
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

    await page.goto(new URL('/receive', webUrl).href, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Paste', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'PIN, onion address, or sender code', exact: true })
      .fill(offer);
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    let answer = await copiedText(page, 'Response data to copy');
    if (relay) {
      await page.getByText('Advanced options', { exact: true }).click();
      await page.getByRole('button', { name: 'Simulate no direct connection' }).click();
      await page
        .getByRole('button', { name: 'Go back to a direct connection' })
        .waitFor({ state: 'visible', timeout: 30_000 });
      // The response is built again with no routes in it; wait for it.
      const text = page.getByRole('textbox', {
        name: 'Response data to copy',
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

    const downloadButton = page.getByRole('button', { name: 'Download File' });
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

  if (SCENARIOS.has('web-to-cli')) await webToCli(browser, false);
  if (SCENARIOS.has('cli-to-web')) await cliToWeb(browser, false);
  if (SCENARIOS.has('web-to-cli-relay')) await webToCli(browser, true);
  if (SCENARIOS.has('cli-to-web-relay')) await cliToWeb(browser, true);
  if (SCENARIOS.has('web-to-cli-anonymous')) {
    await webToCli(browser, true, true);
  }
  console.log(`\nAll Code Exchange CLI <-> web transfers passed in ${elapsed()}.`);
} catch (error) {
  console.error(`\n[FAIL] ${(error as Error).stack ?? error}`);
  console.error(`Artifacts: ${ARTIFACTS}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
