#!/usr/bin/env npx tsx
/**
 * Build a Tor directory snapshot for Anonymous signaling.
 *
 * The browser Tor client (webtor) normally downloads the consensus and the
 * relay microdescriptors itself, over a single Snowflake circuit, one small
 * chunk at a time. That download is the least reliable part of the bootstrap.
 * This tool fetches the same two documents straight from a directory
 * authority and writes them in the exact shape the WASM client accepts, so
 * the browser can start from a ready-made directory instead.
 *
 * A microdesc consensus is only valid for three hours (`valid-until`), and
 * the WASM client rejects an expired one, so the snapshot must be rebuilt at
 * least hourly to be useful in production.
 *
 * Usage: npx tsx scripts/fetch-tor-directory.ts [output-path]
 */

import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';

/** Directory authorities that serve their DirPort on a plain HTTP port. */
const AUTHORITIES = [
  'http://45.66.35.11:80', // dizum
  'http://204.13.164.118:80', // bastet
  'http://131.188.40.189:80', // gabelmoo
  'http://199.58.81.140:80', // longclaw
  'http://171.25.193.9:443', // maatuska (plain HTTP on 443)
];

const CONSENSUS_PATH = '/tor/status-vote/current/consensus-microdesc.z';
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Digests per microdescriptor request. Every digest is one 43-character path
 * segment, so the batch size is bounded by the directory's URL length limit.
 */
const DIGESTS_PER_REQUEST = 90;
/** Concurrent microdescriptor requests against one authority. */
const PARALLEL_REQUESTS = 4;
/**
 * webtor refuses a directory with fewer than 10 usable middle relays. It is
 * a floor for a sane consensus here, not a target: the snapshot carries every
 * relay in the consensus.
 */
const MIN_RELAYS_PER_ROLE = 10;
/** webtor also needs every HSDir to place onion services on the hash ring. */
const MIN_HSDIR_RELAYS = 100;
const CACHE_VERSION = 2;

/** One connection per authority carries hundreds of microdescriptor requests. */
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: PARALLEL_REQUESTS,
});

interface RouterEntry {
  microdescDigest: string;
  flags: Set<string>;
  bandwidth: number;
}

/**
 * Directory authorities answer with bare HTTP/1.0 responses that Node's
 * `fetch` refuses to frame, so talk to them with the raw HTTP client.
 */
function httpGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      url,
      {
        agent: keepAliveAgent,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'user-agent': 'ptransfer-directory-snapshot' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error('Request timed out')),
    );
    request.on('error', reject);
  });
}

async function fetchFromAuthority(documentPath: string): Promise<Buffer> {
  const failures: string[] = [];
  for (const authority of AUTHORITIES) {
    try {
      const body = await httpGet(`${authority}${documentPath}`);
      // The `.z` suffix means zlib-compressed, per dir-spec.
      return documentPath.endsWith('.z') ? zlib.inflateSync(body) : body;
    } catch (error) {
      failures.push(
        `${authority}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `No directory authority served ${documentPath}\n  ${failures.join('\n  ')}`,
  );
}

/**
 * Read the router entries out of a microdesc consensus. Each entry starts at
 * an `r` line and carries its microdescriptor digest (`m`), flags (`s`) and
 * consensus weight (`w`).
 */
function parseRouterEntries(consensus: string): RouterEntry[] {
  const entries: RouterEntry[] = [];
  let current: Partial<RouterEntry> | null = null;

  const push = () => {
    if (current?.microdescDigest && current.flags) {
      entries.push({
        microdescDigest: current.microdescDigest,
        flags: current.flags,
        bandwidth: current.bandwidth ?? 0,
      });
    }
  };

  for (const line of consensus.split('\n')) {
    if (line.startsWith('r ')) {
      push();
      current = { flags: new Set(), bandwidth: 0 };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('m ')) {
      current.microdescDigest = line.slice(2).trim();
    } else if (line.startsWith('s ')) {
      current.flags = new Set(line.slice(2).trim().split(' '));
    } else if (line.startsWith('w ')) {
      const bandwidth = /Bandwidth=(\d+)/.exec(line);
      current.bandwidth = bandwidth ? Number(bandwidth[1]) : 0;
    } else if (line.startsWith('directory-footer')) {
      push();
      current = null;
    }
  }
  push();
  return entries;
}

function consensusLifetime(consensus: string): {
  after: string;
  until: string;
} {
  const after = /^valid-after (.+)$/m.exec(consensus)?.[1] ?? 'unknown';
  const until = /^valid-until (.+)$/m.exec(consensus)?.[1] ?? 'unknown';
  return { after: after.trim(), until: until.trim() };
}

/**
 * Every microdescriptor digest in the consensus, in consensus order. webtor
 * samples a few relays per role because it pulls each one through a Snowflake
 * circuit; fetching from an authority is fast enough to carry the whole
 * network, which leaves path selection weighted across all of it.
 */
function collectDigests(entries: RouterEntry[]): string[] {
  const usable = entries.filter(
    (entry) =>
      entry.bandwidth > 0 &&
      entry.flags.has('Fast') &&
      entry.flags.has('Stable'),
  );
  const middle = usable.filter((entry) => entry.flags.has('V2Dir')).length;
  const hsdir = entries.filter((entry) => entry.flags.has('HSDir')).length;
  console.log(
    `Consensus has ${entries.length} relays; ${middle} usable middle, ${hsdir} HSDir`,
  );
  if (middle < MIN_RELAYS_PER_ROLE || hsdir < MIN_HSDIR_RELAYS) {
    throw new Error('Consensus has too few usable relays for a snapshot');
  }

  return [...new Set(entries.map((entry) => entry.microdescDigest))];
}

async function fetchMicrodescriptors(digests: string[]): Promise<string> {
  const chunks: string[][] = [];
  for (let i = 0; i < digests.length; i += DIGESTS_PER_REQUEST) {
    chunks.push(digests.slice(i, i + DIGESTS_PER_REQUEST));
  }

  const documents: string[] = new Array(chunks.length).fill('');
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const index = next++;
      const body = await fetchFromAuthority(
        `/tor/micro/d/${chunks[index].join('-')}.z`,
      );
      documents[index] = body.toString('utf8');
      done++;
      if (done % 10 === 0 || done === chunks.length) {
        console.log(`Fetched microdescriptor batch ${done}/${chunks.length}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_REQUESTS, chunks.length) }, worker),
  );
  return documents.join('');
}

async function main(): Promise<void> {
  const outputPath = path.resolve(
    process.argv[2] ??
      path.join(import.meta.dirname, '..', 'public', 'tor-directory.json'),
  );

  console.log('Fetching the current microdesc consensus...');
  const consensus = (await fetchFromAuthority(CONSENSUS_PATH)).toString('utf8');
  const lifetime = consensusLifetime(consensus);
  console.log(
    `Consensus ${(consensus.length / 1024 / 1024).toFixed(2)} MiB, valid ${lifetime.after} .. ${lifetime.until} UTC`,
  );

  const digests = collectDigests(parseRouterEntries(consensus));
  const microdescriptors = await fetchMicrodescriptors(digests);
  const found = microdescriptors.match(/^onion-key$/gm)?.length ?? 0;
  console.log(`Received ${found} of ${digests.length} microdescriptors`);
  // Relays leave the network between the consensus and this fetch, so a few
  // missing microdescriptors are normal; a large shortfall is not.
  if (found < digests.length * 0.9) {
    throw new Error('Too few microdescriptors came back to build a snapshot');
  }

  const snapshot = JSON.stringify({
    version: CACHE_VERSION,
    consensus,
    microdescriptors,
  });
  writeFileSync(outputPath, snapshot);
  console.log(
    `Wrote ${outputPath} (${(snapshot.length / 1024 / 1024).toFixed(2)} MiB); rebuild before ${lifetime.until} UTC`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
