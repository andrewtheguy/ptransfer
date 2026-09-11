import type { ParseArgsOptionsConfig } from 'node:util';
import type { DirectoryDescription, WebtorClient } from '@/lib/tor/webtor-api';
import { UsageError } from '../usage';
import { fetchDirectorySeed } from './directory-fetch';
import { openDirectoryStore } from './directory-store';
import { loadWebtor } from './webtor';

/**
 * Bootstrapping the Tor client for one command, the way every Tor command
 * does it:
 *
 * 1. Load the Tor client — the same wasm the browser tab runs.
 * 2. Get a directory: the seed cached from the last run if it still
 *    describes the network, otherwise a fresh one over plain HTTP from the
 *    authorities, which is the fast path a browser does not have.
 * 3. Bootstrap over the Snowflake bridge.
 *
 * The browser's counterpart is `bootstrapTorClient` in `src/lib/tor/client.ts`;
 * the two differ only in where the directory comes from and goes to.
 */

/** The flags every Tor command takes, for `parseArgs`. */
export const TOR_OPTIONS = {
  'refresh-directory': { type: 'boolean', default: false },
  'cache-dir': { type: 'string' },
  'bridge-url': { type: 'string' },
  'bridge-fingerprint': { type: 'string' },
} as const satisfies ParseArgsOptionsConfig;

/** Their help text, for a command's usage. */
export const TOR_OPTIONS_USAGE = `  --refresh-directory      ignore the cached directory and download a fresh one
  --cache-dir <path>       where to keep the directory seed (default:
                           ~/Library/Caches/ptransfer on macOS, otherwise
                           $XDG_CACHE_HOME/ptransfer or ~/.cache/ptransfer)
  --bridge-url <ws://...>  a Snowflake bridge to use instead of the public one;
                           requires --bridge-fingerprint
  --bridge-fingerprint <hex>`;

export interface TorOptions {
  refreshDirectory: boolean;
  cacheDir?: string;
  /** A bridge other than the public one; both or neither. */
  bridge?: { url: string; fingerprint: string };
}

/** The parsed flags as options, checked for consistency. */
export function torOptionsFrom(values: {
  'refresh-directory'?: boolean;
  'cache-dir'?: string;
  'bridge-url'?: string;
  'bridge-fingerprint'?: string;
}): TorOptions {
  const url = values['bridge-url'];
  const fingerprint = values['bridge-fingerprint'];
  if (Boolean(url) !== Boolean(fingerprint)) {
    throw new UsageError(
      'Give --bridge-url and --bridge-fingerprint together, or neither',
    );
  }
  return {
    refreshDirectory: values['refresh-directory'] ?? false,
    cacheDir: values['cache-dir'],
    ...(url && fingerprint ? { bridge: { url, fingerprint } } : {}),
  };
}

export interface BootstrapOptions extends TorOptions {
  /** Progress, one line at a time. */
  say: (line: string) => void;
  /**
   * Whether the Tor client's own log lines are worth showing. Warnings and
   * errors always are.
   */
  verbose: boolean;
  /** Called as each stage completes, for a command that times them. */
  onLap?: (label: string) => void;
}

/**
 * Bootstrap a Tor client. Resolves once it has a Tor channel and a directory;
 * it has reached nothing at that point. The caller owns the client and must
 * `close()` it.
 */
export async function bootstrapTor(
  options: BootstrapOptions,
): Promise<WebtorClient> {
  const { say, onLap = () => {} } = options;

  say('Loading the Tor client...');
  const { WebtorClient, describeDirectory } = await loadWebtor();
  onLap('load the Tor client');

  const store = openDirectoryStore(options.cacheDir);
  let seed = options.refreshDirectory
    ? undefined
    : await store.load(describeDirectory, (reason) =>
        say(`Ignoring the cached directory: ${reason}`),
      );
  let directory: DirectoryDescription | undefined;
  if (seed) {
    directory = describeDirectory(seed);
    say(`Using the cached directory in ${store.path}`);
    onLap('read the cached directory');
  } else {
    try {
      const fresh = await fetchDirectorySeed({ onProgress: say });
      // Read it before keeping it: a seed the client cannot read is worth
      // neither a file nor a bootstrap.
      directory = describeDirectory(fresh);
      seed = fresh;
    } catch (error) {
      // The fast path is a convenience: without a seed the client downloads
      // the directory through the bridge itself, which is what a tab does.
      seed = undefined;
      say(
        `Could not download the directory from the authorities: ${error instanceof Error ? error.message : String(error)}`,
      );
      say(
        'The client will download it through the bridge instead; expect minutes',
      );
    }
    onLap('download the directory');
    if (seed) {
      const kept = await store.save(seed, (reason) =>
        say(`Could not keep the directory: ${reason}`),
      );
      if (kept) say(`Kept the directory in ${store.path}`);
    }
  }

  // The time period places the HSDir ring: peers more than one period apart
  // cannot reach each other, and nothing else in either log says so.
  if (directory) {
    say(
      `Directory: consensus valid ${directory.validAfter.toISOString()} to ` +
        `${directory.validUntil.toISOString()}, onion time period ` +
        `${directory.timePeriod}`,
    );
  }

  say('Bootstrapping Tor...');
  const client = await WebtorClient.create({
    bridge: 'websocket',
    ...(options.bridge
      ? {
          bridgeUrl: options.bridge.url,
          bridgeFingerprint: options.bridge.fingerprint,
        }
      : {}),
    ...(seed ? { directorySeed: seed } : {}),
    onLog: (message, level) => {
      if (options.verbose || level === 'warn' || level === 'error') {
        say(`[webtor ${level}] ${message}`);
      }
    },
    // A long-lived client refreshes its directory; keep what it downloads so
    // the next run starts from it. A seed this side supplied is never handed
    // back, so nothing here rewrites what it just read.
    onDirectoryChange: (fresh) => void store.save(fresh),
  });
  onLap('bootstrap');
  return client;
}

/** Close a client, swallowing the failure — teardown has nothing to report. */
export async function closeTor(client: WebtorClient | null): Promise<void> {
  if (!client) return;
  try {
    await client.close();
  } catch (error) {
    process.stderr.write(
      `Failed to close the Tor client: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
