// Shared plumbing for the live browser tests: a Chrome-family browser driven
// by playwright-core, a pTransfer dev server to point it at, and the process
// and byte-comparison helpers both scenarios need.
//
// playwright-core is installed at runtime into a cache directory rather than
// being a project dependency, so its own type declarations are not imported
// here; the interfaces below are the structural views these scripts use.

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface PwLocator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  first(): PwLocator;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  setInputFiles(files: string): Promise<void>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
}

export interface PwDownload {
  saveAs(path: string): Promise<void>;
}

export interface PwPage {
  getByRole(
    role: string,
    options?: { name?: string; exact?: boolean },
  ): PwLocator;
  getByText(text: string, options?: { exact?: boolean }): PwLocator;
  getByTestId(testId: string): PwLocator;
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  locator(selector: string): PwLocator;
  on(event: 'pageerror', handler: (error: Error) => void): void;
  on(
    event: 'console',
    handler: (message: { type(): string; text(): string }) => void,
  ): void;
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

export interface PwBrowserContext {
  close(): Promise<void>;
  newPage(): Promise<PwPage>;
}

export interface PwBrowser {
  close(): Promise<void>;
  newContext(options?: {
    acceptDownloads?: boolean;
  }): Promise<PwBrowserContext>;
}

export interface PwBrowserType {
  launch(options?: {
    args?: string[];
    executablePath?: string;
    headless?: boolean;
  }): Promise<PwBrowser>;
}

export interface PackageIdentity {
  name: string;
  version: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** The repository root: `tests/support` is two levels down from it. */
export const WEB_ROOT = resolve(SCRIPT_DIR, '..', '..');

const CACHE_ROOT = resolve(
  process.env.PTRANSFER_E2E_CACHE ??
    join(tmpdir(), 'ptransfer-web-live-e2e-cache'),
);
const PLAYWRIGHT_VERSION = process.env.PTRANSFER_PLAYWRIGHT_VERSION ?? '1.55.0';

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

export async function withTimeout<T>(
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

export async function runCommand(
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
    const version =
      servedPackage.name === expectedPackageName &&
      typeof servedPackage.version === 'string'
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

export interface WebServer {
  url: URL;
  /** The dev server this harness started, if it started one. */
  process: ChildProcess | undefined;
}

/**
 * Start a pTransfer dev server for the run, or reuse an already-running one
 * when the operator has explicitly asked for that.
 *
 * Reuse is opt-in (`PTRANSFER_E2E_REUSE_SERVER=1`) because a served
 * name/version says nothing about what the server was actually built from: not
 * the working tree it is serving, and not the `VITE_*` settings it baked into
 * the page — a run against a bridge-less server would look exactly like a run
 * against the local bridge it was asked for. Starting one is a few seconds; a
 * live test that quietly measured the wrong build is worth much more than that.
 */
export async function ensureWebServer(
  expectedPackage: PackageIdentity,
  requestedUrl: URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WebServer> {
  const reuseAllowed = process.env.PTRANSFER_E2E_REUSE_SERVER === '1';
  const existing = await probeWebServer(requestedUrl, expectedPackage.name);
  if (reuseAllowed && existing.version === expectedPackage.version) {
    console.log(
      `[setup] PTRANSFER_E2E_REUSE_SERVER=1: using pTransfer ${existing.version} ` +
        `at ${requestedUrl.origin} without checking what it was built with`,
    );
    return { url: requestedUrl, process: undefined };
  }

  if (existing.reachable) {
    console.log(
      `[setup] not reusing ${requestedUrl.origin}: ` +
        (reuseAllowed
          ? `expected pTransfer ${expectedPackage.version}, found ` +
            `${existing.version ?? 'an unverified response'}`
          : 'set PTRANSFER_E2E_REUSE_SERVER=1 to reuse a running server'),
    );
  }
  await access(
    join(WEB_ROOT, 'node_modules', '.bin', 'vite'),
    fsConstants.X_OK,
  ).catch(() => {
    throw new Error(`Missing web dependencies; run bun install in ${WEB_ROOT}`);
  });

  const requestedIsAvailableLoopback =
    !existing.reachable &&
    requestedUrl.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(requestedUrl.hostname);
  const url = requestedIsAvailableLoopback
    ? requestedUrl
    : await availableLoopbackUrl();

  const port = url.port || '80';
  console.log(
    `[setup] starting pTransfer ${expectedPackage.version} at ${url.origin}`,
  );
  const server = spawn(
    'bun',
    [
      'run',
      'dev',
      '--',
      '--host',
      url.hostname,
      '--port',
      port,
      '--strictPort',
    ],
    {
      cwd: WEB_ROOT,
      detached: true,
      env,
      stdio: 'inherit',
    },
  );
  server.once('error', (error) => {
    console.error(`[web] ${error.stack ?? error}`);
  });

  // Until it is handed back, this server belongs to nobody: the caller has no
  // reference to terminate, and it was spawned detached, so anything thrown
  // from the readiness wait has to take it down first.
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error('pTransfer exited before becoming ready');
      }
      const probe = await probeWebServer(url, expectedPackage.name);
      if (probe.version === expectedPackage.version) {
        return { url, process: server };
      }
      await sleep(250);
    }
    throw new Error(
      `pTransfer ${expectedPackage.version} did not become ready at ${url.origin}`,
    );
  } catch (error) {
    await terminate(server, true).catch(() => undefined);
    throw error;
  }
}

export async function loadChromium(): Promise<PwBrowserType> {
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
    await runCommand('bun', [
      'install',
      '--no-save',
      '--cwd',
      CACHE_ROOT,
      `playwright-core@${PLAYWRIGHT_VERSION}`,
    ]);
  }
  const playwright = (await import(pathToFileURL(playwrightEntry).href)) as {
    chromium: PwBrowserType;
  };
  return playwright.chromium;
}

export async function findBrowser(): Promise<string> {
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
    join(
      homedir(),
      'Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ),
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

/**
 * Collect page errors, and return an assertion that fails the scenario if any
 * were raised. A transfer that completed while the page was throwing is not a
 * passing test.
 */
export function instrumentPage(page: PwPage, label: string): () => void {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error);
    console.error(`[${label}:pageerror] ${error.stack ?? error}`);
  });
  return () => {
    if (pageErrors.length > 0) {
      throw new Error(
        `${label}: browser page raised ${pageErrors.length} error(s)`,
      );
    }
  };
}

export async function assertSameBytes(
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

export async function terminate(
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
  const exited = new Promise((resolvePromise) =>
    child.once('exit', resolvePromise),
  );
  try {
    await withTimeout(exited, 5_000, 'child process shutdown');
  } catch {
    signal('SIGKILL');
  }
}

/** The identity the running server is checked against. */
export async function readPackageIdentity(): Promise<PackageIdentity> {
  return JSON.parse(
    await readFile(join(WEB_ROOT, 'package.json'), 'utf8'),
  ) as PackageIdentity;
}
