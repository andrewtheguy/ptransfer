import { getStunUrls } from '@/lib/webrtc-config';
import {
  describeDirectory,
  judgeDirectorySeed,
  loadDirectorySeed,
  saveDirectoryCache,
} from './directory-cache';
import { loadWebtor, type WebtorClient } from './webtor';

/**
 * Bootstrapping the browser Tor client both directions of the Tor transfer
 * share.
 *
 * Nothing here reaches a clearnet destination: every circuit this client
 * builds ends at an onion service, so there is no exit, no TLS to terminate in
 * WASM, and no certificate a page could meaningfully check. Reaching the Tor
 * network at all is a Snowflake bridge's job, and which kind of bridge is the
 * one choice this exposes.
 */

/**
 * How the tab reaches its Snowflake bridge.
 *
 * - `websocket` opens a direct WebSocket to one fixed bridge endpoint: no
 *   broker, no volunteer proxy, no STUN. Fewer moving parts, and the faster of
 *   the two, but a network that blocks that endpoint blocks the transfer.
 * - `webrtc` goes through a volunteer proxy brokered over HTTPS, which is what
 *   Snowflake is designed for and much harder to block — at the cost of
 *   needing STUN and a proxy being available.
 */
export type TorBridge = 'websocket' | 'webrtc';

export const TOR_BRIDGES: readonly TorBridge[] = ['websocket', 'webrtc'];

export const DEFAULT_TOR_BRIDGE: TorBridge = 'websocket';

/** Labels for the bridge choice, used wherever it is offered. */
export const TOR_BRIDGE_LABELS: Record<TorBridge, string> = {
  websocket: 'Snowflake WebSocket',
  webrtc: 'Snowflake WebRTC',
};

/**
 * A bridge to use instead of the public one, from the build's environment:
 *
 * ```
 * VITE_TOR_BRIDGE_URL=ws://localhost:8080/
 * VITE_TOR_BRIDGE_FINGERPRINT=<what webtor-rs's scripts/local-bridge prints>
 * ```
 *
 * Worth setting while developing, because the client fetches the consensus and
 * every HSDir microdescriptor one hop from the bridge: against a local one that
 * download is local too, which turns a multi-minute cold bootstrap into
 * seconds. Both or neither — a URL without an identity would be a request to
 * trust whatever answers.
 */
const BRIDGE_URL = import.meta.env.VITE_TOR_BRIDGE_URL;
const BRIDGE_FINGERPRINT = import.meta.env.VITE_TOR_BRIDGE_FINGERPRINT;

if (Boolean(BRIDGE_URL) !== Boolean(BRIDGE_FINGERPRINT)) {
  throw new Error(
    'Set VITE_TOR_BRIDGE_URL and VITE_TOR_BRIDGE_FINGERPRINT together, or neither',
  );
}

export interface BootstrapOptions {
  bridge: TorBridge;
  /** Progress for the UI; the client's own detail goes to the console. */
  onStatus?: (message: string) => void;
}

/**
 * Bootstrap a Tor client for one transfer.
 *
 * Resolves once the client has a Tor channel and a directory. It has reached
 * nothing at that point — the first proof the whole path works is the transfer
 * itself, which is the only onion address either side cares about.
 *
 * The caller owns the returned client and must `close()` it; every circuit it
 * holds lives until then.
 */
export async function bootstrapTorClient(
  options: BootstrapOptions,
): Promise<WebtorClient> {
  const { onStatus } = options;

  onStatus?.('Loading the Tor client...');
  const { WebtorClient } = await loadWebtor();

  const seed = await loadDirectorySeed();
  onStatus?.(
    seed.value
      ? `Bootstrapping Tor (directory from the ${seed.source})...`
      : 'Bootstrapping Tor and downloading the directory; this takes a few minutes on a first run...',
  );

  const client = await WebtorClient.create({
    bridge: options.bridge,
    ...(options.bridge === 'webrtc' ? { stunUrls: getStunUrls() } : {}),
    ...(BRIDGE_URL && BRIDGE_FINGERPRINT
      ? { bridgeUrl: BRIDGE_URL, bridgeFingerprint: BRIDGE_FINGERPRINT }
      : {}),
    ...(seed.value ? { directorySeed: seed.value } : {}),
    logPrefix: '[tor]',
  });

  // Keep the verified directory for the next transfer, and report which one
  // this client ended up with. Best effort: a failure here only costs the next
  // bootstrap a download.
  void client
    .directoryCache()
    .then(async (cache) => {
      logDirectory(cache);
      await saveDirectoryCache(cache);
    })
    .catch(() => undefined);

  return client;
}

/**
 * Say which directory this client is working from.
 *
 * The time period is the number that has to match on both sides: it places the
 * HSDir ring, so a service and a client that disagree about it fail as a flat
 * 404 from every HSDir tried, with nothing in either log naming the cause.
 * Printing it on both peers turns that into a comparison anyone can make.
 */
function logDirectory(cache: string): void {
  const directory = describeDirectory(cache);
  if (!directory) return;
  console.info(
    `[tor] Directory: consensus valid ${directory.validAfter.toISOString()} to ` +
      `${directory.validUntil.toISOString()}, onion time period ` +
      `${directory.timePeriod} (both peers must be in the same period)`,
  );

  // A stored directory in that state is refused before it is ever installed,
  // so reaching here means the network itself served a consensus from the
  // previous period — a bridge or relay an hour behind. Nothing this side can
  // fix, but it is the whole explanation for a transfer that is about to fail
  // with a 404 from every HSDir, so it is worth saying plainly.
  const verdict = judgeDirectorySeed(cache);
  if (!verdict.usable) {
    console.warn(
      `[tor] This directory is not current: ${verdict.reason}. A peer whose ` +
        'directory is current will not find this service, and this client ' +
        'will not find theirs.',
    );
  }
}

/** Close a client, swallowing the failure — teardown has nothing to report. */
export async function closeTorClient(
  client: WebtorClient | null,
): Promise<void> {
  if (!client) return;
  try {
    await client.close();
  } catch (error) {
    console.info('[tor] Failed to close the Tor client:', error);
  }
}
