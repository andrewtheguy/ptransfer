import { parseArgs } from 'node:util';
import type { OnionService, OnionStream } from '@/lib/tor/webtor-api';
import { routeDiagnostics } from '../diagnostics';
import {
  bootstrapTor,
  TOR_OPTIONS,
  TOR_OPTIONS_USAGE,
  torOptionsFrom,
} from '../tor/bootstrap';
import { UsageError } from '../usage';

/**
 * `ptransfer tor-test`: prove the whole Tor path from this machine, end to
 * end, with nothing else involved.
 *
 * 1. Bootstrap the way every Tor command does (`../tor/bootstrap.ts`): load
 *    the client, get a directory, reach the network over the bridge.
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
${TOR_OPTIONS_USAGE}
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
      ...TOR_OPTIONS,
      url: { type: 'string', default: DEFAULT_URL },
      'intro-points': { type: 'string', default: '1' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const torOptions = torOptionsFrom(values);
  routeDiagnostics(true);
  const url = values.url === 'none' ? undefined : values.url;
  if (url && !/^http:\/\/[a-z2-7]{56}\.onion(?::\d+)?(?:\/|$)/i.test(url)) {
    throw new UsageError(
      '--url must be http://<v3 address>.onion/... (no TLS: the address is the key)',
    );
  }
  const introPoints = Number(values['intro-points']);
  if (!Number.isInteger(introPoints) || introPoints < 1 || introPoints > 6) {
    throw new UsageError('--intro-points must be a whole number from 1 to 6');
  }

  const say = (line: string) => process.stderr.write(`${line}\n`);
  const clock = new Stopwatch();

  // A self-check shows everything the client says.
  const client = await bootstrapTor({
    ...torOptions,
    verbose: true,
    say,
    onLap: (label) => clock.lap(label),
  });

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
