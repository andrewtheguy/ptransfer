import { parseArgs } from 'node:util';
import type {
  DirectoryDescription,
  OnionService,
  OnionStream,
} from '@/lib/tor/webtor-api';
import { fetchDirectorySeed } from '../tor/directory-fetch';
import { openDirectoryStore } from '../tor/directory-store';
import { loadWebtor } from '../tor/webtor';

/**
 * `ptransfer tor-test`: prove the whole Tor path from this machine, end to
 * end, with nothing else involved.
 *
 * 1. Load the Tor client — the same wasm the browser tab runs.
 * 2. Get a directory: the seed cached from the last run if it still
 *    describes the network, otherwise a fresh one over plain HTTP from the
 *    authorities, which is the fast path a browser does not have.
 * 3. Bootstrap over the Snowflake bridge.
 * 4. Fetch a page from a real onion service somebody else runs: the proof
 *    that a full rendezvous works against the network as it is, not only
 *    against this process.
 * 5. Publish a v3 onion service, connect back to it through the network,
 *    and round-trip a message.
 *
 * Each step is timed and the timings are the output: a bootstrap that used
 * to take minutes in a tab should take seconds here, and this is the number
 * that says whether it does.
 */

const USAGE = `usage: ptransfer tor-test [options]

Bootstrap Tor, fetch a page from an onion service, publish an onion service
of this process's own, and connect back to it.

options:
  --url <http://...onion/...>
                           the onion URL to fetch (default: the Tor Project's
                           site); --url none skips the fetch
  --refresh-directory      ignore the cached directory and download a fresh one
  --cache-dir <path>       where to keep the directory seed (default: the
                           platform's per-user cache directory)
  --bridge-url <ws://...>  a Snowflake bridge to use instead of the public one;
                           requires --bridge-fingerprint
  --bridge-fingerprint <hex>
  --intro-points <n>       introduction points for the service (default 1)
  -h, --help
`;

const PORT = 9735;
/**
 * The Tor Project's own site as a v3 onion over plain HTTP: a service that
 * is expected to stay up, run by people who are not us, so reaching it says
 * something reaching our own service cannot. The wasm compiles in no
 * address of its own; what a client is checked against is the caller's
 * choice, and this is ours.
 */
const DEFAULT_URL =
  'http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/';
const PROBE = 'ping from ptransfer tor-test';

class Stopwatch {
  private readonly started = performance.now();
  private last = this.started;
  readonly laps: [string, number][] = [];

  lap(label: string): void {
    const now = performance.now();
    this.laps.push([label, now - this.last]);
    this.last = now;
  }

  get total(): number {
    return performance.now() - this.started;
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The next `length` bytes as text, or null if the stream ends first. A Tor
 * stream is a byte stream: one `receive` may hand back part of what the peer
 * wrote in one `send`.
 */
async function readExactly(
  stream: OnionStream,
  length: number,
): Promise<string | null> {
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < length) {
    const next = await stream.receive();
    if (!next) return null;
    parts.push(next);
    total += next.length;
  }
  return Buffer.concat(parts).toString('utf8');
}

export async function torTest(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', default: DEFAULT_URL },
      'refresh-directory': { type: 'boolean', default: false },
      'cache-dir': { type: 'string' },
      'bridge-url': { type: 'string' },
      'bridge-fingerprint': { type: 'string' },
      'intro-points': { type: 'string', default: '1' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (Boolean(values['bridge-url']) !== Boolean(values['bridge-fingerprint'])) {
    process.stderr.write(
      'Give --bridge-url and --bridge-fingerprint together, or neither\n',
    );
    return 2;
  }
  const url = values.url === 'none' ? undefined : values.url;
  if (url && !/^http:\/\/[a-z2-7]{56}\.onion(?::\d+)?(?:\/|$)/i.test(url)) {
    process.stderr.write(
      '--url must be http://<v3 address>.onion/... (no TLS: the address is the key)\n',
    );
    return 2;
  }
  const introPoints = Number(values['intro-points']);
  if (!Number.isInteger(introPoints) || introPoints < 1 || introPoints > 6) {
    process.stderr.write('--intro-points must be a whole number from 1 to 6\n');
    return 2;
  }

  const say = (line: string) => process.stderr.write(`${line}\n`);
  const clock = new Stopwatch();

  const { WebtorClient, describeDirectory } = await loadWebtor();
  clock.lap('load the Tor client');

  const store = openDirectoryStore(values['cache-dir']);
  let seed = values['refresh-directory']
    ? undefined
    : await store.load(describeDirectory, (reason) =>
        say(`Ignoring the cached directory: ${reason}`),
      );
  let directory: DirectoryDescription | undefined;
  if (seed) {
    directory = describeDirectory(seed);
    say(`Using the cached directory in ${store.path}`);
    clock.lap('read the cached directory');
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
    clock.lap('download the directory');
    if (seed) {
      const kept = await store.save(seed, (reason) =>
        say(`Could not keep the directory: ${reason}`),
      );
      if (kept) say(`Kept the directory in ${store.path}`);
    }
  }

  if (directory) {
    say(
      `Directory: consensus valid ${directory.validAfter.toISOString()} to ` +
        `${directory.validUntil.toISOString()}, onion time period ` +
        `${directory.timePeriod}`,
    );
  }

  const client = await WebtorClient.create({
    bridge: 'websocket',
    ...(values['bridge-url'] && values['bridge-fingerprint']
      ? {
          bridgeUrl: values['bridge-url'],
          bridgeFingerprint: values['bridge-fingerprint'],
        }
      : {}),
    ...(seed ? { directorySeed: seed } : {}),
    onLog: (message, level) => say(`[webtor ${level}] ${message}`),
    // A long-lived client refreshes its directory; keep what it downloads so
    // the next run starts from it. A seed this side supplied is never handed
    // back, so nothing here rewrites what it just read.
    onDirectoryChange: (fresh) => void store.save(fresh),
  });
  clock.lap('bootstrap');

  let service: OnionService | undefined;
  try {
    if (url) {
      const response = await client.fetch(url);
      clock.lap('fetch an onion page');
      const type = response.headers.get('content-type') ?? 'unknown type';
      say(
        `GET ${url} -> HTTP ${response.status}, ${response.bytes().length} bytes of ${type}`,
      );
      if (!response.ok) {
        throw new Error(`${url} answered HTTP ${response.status}`);
      }
    }

    service = await client.publishOnionService({ introPoints });
    clock.lap('publish the onion service');
    say(`Published ${service.onionAddress}`);

    const served = (async () => {
      const stream = await service.accept();
      if (!stream) throw new Error('The service closed before a client came');
      try {
        const text = await readExactly(stream, Buffer.byteLength(PROBE));
        if (text !== PROBE) {
          throw new Error(`The service received ${JSON.stringify(text)}`);
        }
        await stream.send(`echo: ${text}`);
      } finally {
        // Closing on failure too is what lets the client's read end instead
        // of waiting on a reply that is never coming.
        await stream.close().catch(() => undefined);
      }
    })();
    // A failure here before `served` is awaited below must not surface as an
    // unhandled rejection; the await still sees it.
    served.catch(() => undefined);

    const stream = await client.connectStream(service.onionAddress, PORT);
    clock.lap('connect back to it');
    try {
      await stream.send(PROBE);
      const expected = `echo: ${PROBE}`;
      const echoed = await readExactly(stream, Buffer.byteLength(expected));
      if (echoed !== expected) {
        throw new Error(`The client received ${JSON.stringify(echoed)}`);
      }
    } finally {
      await stream.close().catch(() => undefined);
    }
    await served;
    clock.lap('round-trip a message');
  } finally {
    await service?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  }

  const width = Math.max(...clock.laps.map(([label]) => label.length));
  const lines = clock.laps.map(
    ([label, ms]) => `${label.padEnd(width)}  ${seconds(ms).padStart(7)}`,
  );
  process.stdout.write(
    `${lines.join('\n')}\n${'total'.padEnd(width)}  ${seconds(clock.total).padStart(7)}\n`,
  );
  return 0;
}
