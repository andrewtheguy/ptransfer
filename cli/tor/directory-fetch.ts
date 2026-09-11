import http from 'node:http';
import zlib from 'node:zlib';

/**
 * Downloading the Tor directory the fast way: plain HTTP to the directory
 * authorities' DirPorts, several requests in flight.
 *
 * This is the one thing a Bun process can do that a browser tab cannot. The
 * client itself downloads the consensus and every HSDir microdescriptor over a
 * single Snowflake circuit, one small batch at a time, which is the slowest
 * and least reliable part of a browser bootstrap — thousands of documents
 * through one circuit. A page has no other way to reach a directory; a
 * process does, and the result is the same `directorySeed` string
 * `WebtorClient.create` takes, assembled in seconds.
 *
 * Nothing here vouches for anything. The certificates travel with the seed
 * and webtor verifies the consensus against its own pinned authorities before
 * installing a single relay, so a seed from the wrong place, or a tampered
 * one, costs a download and never correctness. The checks below only catch a
 * seed that could never be installed, before the client spends a bootstrap
 * finding that out.
 *
 * The seed format (`CACHE_VERSION`) is webtor's; an older envelope is refused
 * and a fresh directory downloaded through the bridge instead, so a version
 * drift here degrades to the slow path rather than failing.
 */

/** Directory authorities that serve their DirPort over plain HTTP. */
const AUTHORITIES = [
  'http://45.66.35.11:80', // dizum
  'http://204.13.164.118:80', // bastet
  'http://131.188.40.189:80', // gabelmoo
  'http://199.58.81.140:80', // longclaw
  'http://171.25.193.9:443', // maatuska (plain HTTP on 443)
];

const CONSENSUS_PATH = '/tor/status-vote/current/consensus-microdesc.z';

/**
 * v3 identity fingerprints of the directory authorities. A signature from
 * anyone else is ignored, and the consensus needs a strict majority of these
 * to be installable — the same rule webtor applies when it installs the seed.
 */
const AUTHORITY_V3IDENTS = new Set([
  '27102BC123E7AF1D4741AE047E160C91ADC76B21', // bastet
  '0232AF901C31A04EE9848595AF9BB7620D4C5B2E', // dannenberg
  'E8A9C45EDE6D711294FADF8E7951F4DE6CA56B58', // dizum
  '70849B868D606BAECFB6128C5E3D782029AA394F', // faravahar
  'ED03BB616EB2F60BEC80151114BB25CEF515B226', // gabelmoo
  '23D15D965BC35114467363C165C4F724B64B4F66', // longclaw
  '49015F787433103580E3B66A1707A00E60F2D15B', // maatuska
  'F533C81CEF0BC0267857C99B2F471ADF249FA232', // moria1
  '2F3DF9CA0E5D36F2685A2DA67184EB8DCB8CBA8C', // tor26
]);
const CONSENSUS_THRESHOLD = Math.floor(AUTHORITY_V3IDENTS.size / 2) + 1;

const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Digests per microdescriptor request. Each is one 43-character path segment,
 * so the batch size is bounded by the directory's URL length limit.
 */
const DIGESTS_PER_REQUEST = 90;
const PARALLEL_REQUESTS = 4;
/** Floors for a sane consensus, matching what the client refuses to install. */
const MIN_RELAYS_PER_ROLE = 10;
const MIN_HSDIR_RELAYS = 100;
/** webtor's `DIRECTORY_CACHE_VERSION`. */
const CACHE_VERSION = 3;

/** One connection per authority carries hundreds of requests. */
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: PARALLEL_REQUESTS,
});

export interface RouterEntry {
  microdescDigest: string;
  flags: Set<string>;
  bandwidth: number;
}

export interface FetchDirectoryOptions {
  /** Progress lines, one per step; there is no other output. */
  onProgress?: (message: string) => void;
}

/**
 * Directory authorities answer with bare HTTP/1.0 responses that `fetch`
 * refuses to frame, so talk to them with the raw HTTP client.
 */
function httpGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      url,
      {
        agent: keepAliveAgent,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'user-agent': 'ptransfer-directory-seed' },
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
      // A `.z` suffix means zlib-compressed, per dir-spec.
      return documentPath.endsWith('.z') ? zlib.inflateSync(body) : body;
    } catch (error: unknown) {
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
 * Read the router entries out of a microdesc consensus. Each starts at an `r`
 * line and carries its microdescriptor digest (`m`), flags (`s`) and consensus
 * weight (`w`).
 */
export function parseRouterEntries(consensus: string): RouterEntry[] {
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

/**
 * The certificate ids the consensus signatures name, restricted to the pinned
 * authorities. A footer line is `directory-signature [algorithm] <id> <sk>`;
 * the algorithm was added later, so the fingerprints are the last two words.
 */
export function signingCertIds(
  consensus: string,
): { id: string; sk: string }[] {
  const ids = new Map<string, { id: string; sk: string }>();
  for (const line of consensus.split('\n')) {
    if (!line.startsWith('directory-signature ')) continue;
    const words = line.trim().split(/\s+/);
    const [id, sk] = words.slice(-2);
    if (!id || !sk || !AUTHORITY_V3IDENTS.has(id.toUpperCase())) continue;
    ids.set(`${id}-${sk}`, { id, sk });
  }
  return [...ids.values()];
}

/** The `valid-after` and `valid-until` lines, as the consensus spells them. */
export function consensusLifetime(consensus: string): {
  after: string;
  until: string;
} {
  const after = /^valid-after (.+)$/m.exec(consensus)?.[1] ?? 'unknown';
  const until = /^valid-until (.+)$/m.exec(consensus)?.[1] ?? 'unknown';
  return { after: after.trim(), until: until.trim() };
}

/**
 * The authority certificates that check `consensus`. The client re-verifies
 * every one of these, so the check here only catches a seed that could never
 * be installed.
 */
async function fetchAuthorityCertificates(
  consensus: string,
  say: (message: string) => void,
): Promise<string> {
  const ids = signingCertIds(consensus);
  say(`Consensus is signed by ${ids.length} known authorities`);
  if (ids.length < CONSENSUS_THRESHOLD) {
    throw new Error(
      `Consensus needs ${CONSENSUS_THRESHOLD} authority signatures, found ${ids.length}`,
    );
  }
  const segments = ids
    .map(({ id, sk }) => `${id.toLowerCase()}-${sk.toLowerCase()}`)
    .sort();
  const certificates = (
    await fetchFromAuthority(`/tor/keys/fp-sk/${segments.join('+')}.z`)
  ).toString('utf8');
  const found =
    certificates.match(/^dir-key-certificate-version /gm)?.length ?? 0;
  say(`Received ${found} of ${ids.length} authority certificates`);
  if (found < CONSENSUS_THRESHOLD) {
    throw new Error(
      `Received ${found} authority certificates, need ${CONSENSUS_THRESHOLD}`,
    );
  }
  return certificates;
}

/**
 * Every microdescriptor digest in the consensus. The client samples a few
 * relays per role because it pulls each one through a Snowflake circuit;
 * fetching from an authority is fast enough to carry the whole network, which
 * leaves path selection weighted across all of it.
 */
export function collectDigests(
  entries: RouterEntry[],
  say: (message: string) => void = () => undefined,
): string[] {
  const usable = entries.filter(
    (entry) =>
      entry.bandwidth > 0 &&
      entry.flags.has('Fast') &&
      entry.flags.has('Stable'),
  );
  const middle = usable.filter((entry) => entry.flags.has('V2Dir')).length;
  const hsdir = entries.filter((entry) => entry.flags.has('HSDir')).length;
  say(
    `Consensus has ${entries.length} relays; ${middle} usable middle, ${hsdir} HSDir`,
  );
  if (middle < MIN_RELAYS_PER_ROLE || hsdir < MIN_HSDIR_RELAYS) {
    throw new Error('Consensus has too few usable relays for a seed');
  }
  return [...new Set(entries.map((entry) => entry.microdescDigest))];
}

async function fetchMicrodescriptors(
  digests: string[],
  say: (message: string) => void,
): Promise<string> {
  const chunks: string[][] = [];
  for (let index = 0; index < digests.length; index += DIGESTS_PER_REQUEST) {
    chunks.push(digests.slice(index, index + DIGESTS_PER_REQUEST));
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
        say(`Fetched microdescriptor batch ${done}/${chunks.length}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_REQUESTS, chunks.length) }, worker),
  );
  return documents.join('');
}

/**
 * Fetch a complete directory seed from the authorities: the current microdesc
 * consensus, the certificates that check it, and every microdescriptor it
 * names. Resolves to the string `WebtorClient.create` takes as
 * `directorySeed`.
 */
export async function fetchDirectorySeed(
  options: FetchDirectoryOptions = {},
): Promise<string> {
  const say = options.onProgress ?? (() => undefined);

  say('Fetching the current microdesc consensus...');
  const consensus = (await fetchFromAuthority(CONSENSUS_PATH)).toString('utf8');
  const lifetime = consensusLifetime(consensus);
  say(
    `Consensus ${(consensus.length / 1024 / 1024).toFixed(2)} MiB, valid ${lifetime.after} .. ${lifetime.until} UTC`,
  );

  const certificates = await fetchAuthorityCertificates(consensus, say);

  const digests = collectDigests(parseRouterEntries(consensus), say);
  const microdescriptors = await fetchMicrodescriptors(digests, say);
  const found = microdescriptors.match(/^onion-key$/gm)?.length ?? 0;
  say(`Received ${found} of ${digests.length} microdescriptors`);
  // Relays leave the network between the consensus and this fetch, so a few
  // missing microdescriptors are normal; a large shortfall is not.
  if (found < digests.length * 0.9) {
    throw new Error('Too few microdescriptors came back to build a seed');
  }

  return JSON.stringify({
    version: CACHE_VERSION,
    consensus,
    certificates,
    microdescriptors,
  });
}
