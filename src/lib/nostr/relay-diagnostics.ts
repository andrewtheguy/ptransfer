import { finalizeEvent } from 'nostr-tools';
import { generateEphemeralKeys } from './events';
import { normalizeRelayUrl } from './relays';
import { EVENT_KIND_DATA_TRANSFER, EVENT_KIND_RENDEZVOUS } from './types';

/**
 * A relay that has not finished the whole round trip by now is not usable for
 * signaling anyway: a PIN rotation is far shorter than a peer's patience.
 */
const PROBE_TIMEOUT_MS = 12_000;

/**
 * NIP-40 lifetime for the probe's kind-4243 event. The rendezvous is a
 * regular kind, so relays retain it; a probe that left one behind for the
 * real expiration window would litter the pool every time this page is used.
 */
const PROBE_EXPIRATION_SEC = 60;

/**
 * Budget for the NIP-11 read that explains a failed socket. It runs only
 * after a relay has already failed, so it must not add noticeably to how long
 * a bad relay takes to report.
 */
const HTTPS_FALLBACK_TIMEOUT_MS = 5000;

export type RelayProbeStatus = 'ok' | 'failed' | 'skipped';

export interface RelayProbeStep {
  /** What was attempted, in the order signaling itself would attempt it. */
  label: string;
  status: RelayProbeStatus;
  /** Round-trip time, the relay's own rejection reason, or why it was skipped. */
  detail?: string;
}

export interface RelayProbeResult {
  url: string;
  /** Every step passed: this relay can carry a PIN Exchange. */
  healthy: boolean;
  /** Whole round trip in ms, or null if the relay never finished one. */
  rttMs: number | null;
  steps: RelayProbeStep[];
}

/**
 * Does this relay actually work for signaling?
 *
 * Opening a socket proves almost nothing — a relay can accept the connection
 * and still refuse the event kinds signaling needs, or acknowledge a write and
 * silently drop it. So the probe performs the real sequence under a throwaway
 * key: publish the rendezvous kind, publish the ephemeral handshake kind, then
 * query the rendezvous back. Only a relay that completes all four steps can
 * put a sender and a receiver in touch.
 *
 * Clearnet only, deliberately. The anonymous pool's relays are onion services
 * that must be reached through Tor, and probing them from here would open the
 * sockets that mode exists to avoid.
 */
export async function probeSignalingRelay(
  url: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<RelayProbeResult> {
  const result = await runSocketProbe(url, timeoutMs);
  const [connect] = result.steps;
  if (connect.status === 'failed') {
    connect.detail = await describeConnectFailure(url, connect.detail);
  }
  return result;
}

/**
 * Why did the socket fail? A browser deliberately withholds that from page
 * script — every failure arrives as close code 1006 with no reason, so the
 * diagnosis the console shows a human is exactly what this page cannot read.
 *
 * Asking for the relay's NIP-11 document over plain HTTPS recovers the useful
 * half of it: a host that answers is up and refusing the upgrade, while one
 * that cannot be reached at all is a DNS, TLS, or connectivity problem. NIP-11
 * requires relays to allow cross-origin reads, so a working relay answers.
 */
async function describeConnectFailure(
  url: string,
  socketDetail: string | undefined,
): Promise<string> {
  // A reason the socket actually gave (outside a browser) beats anything
  // inferred, so it stands on its own.
  const generic =
    !socketDetail || /^closed \(code |^connection failed$/.test(socketDetail);
  const prefix = generic ? 'WebSocket refused' : socketDetail;
  const https = new URL(url);
  https.protocol = 'https:';
  try {
    const response = await fetch(https.toString(), {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(HTTPS_FALLBACK_TIMEOUT_MS),
    });
    return `${prefix} · host answers HTTPS ${response.status}`;
  } catch {
    return `${prefix} · host unreachable over HTTPS too (DNS, TLS, or blocked)`;
  }
}

function runSocketProbe(
  url: string,
  timeoutMs: number,
): Promise<RelayProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const steps: RelayProbeStep[] = [
      { label: 'connect', status: 'skipped' },
      { label: `write kind ${EVENT_KIND_RENDEZVOUS}`, status: 'skipped' },
      { label: `write kind ${EVENT_KIND_DATA_TRANSFER}`, status: 'skipped' },
      { label: 'read back', status: 'skipped' },
    ];
    const [connect, writeRendezvous, writeHandshake, readBack] = steps;

    let settled = false;
    let opened = false;
    let socket: WebSocket | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // A socket that never opened has nothing to close.
      }
      const healthy = steps.every((step) => step.status === 'ok');
      resolve({
        url,
        healthy,
        rttMs: healthy ? Date.now() - started : null,
        steps,
      });
    };
    const timer = setTimeout(() => {
      for (const step of steps) {
        if (step.status === 'skipped') {
          step.status = 'failed';
          step.detail = 'timed out';
        }
      }
      finish();
    }, timeoutMs);

    const { secretKey, publicKey } = generateEphemeralKeys();
    const createdAt = Math.floor(Date.now() / 1000);
    const marker = `probe:${publicKey.slice(0, 16)}`;
    // The production shapes, minus anything PIN-derived: a probe must not put
    // a guessable rendezvous on a relay, and nothing here needs to be one.
    const rendezvous = finalizeEvent(
      {
        kind: EVENT_KIND_RENDEZVOUS,
        created_at: createdAt,
        tags: [
          ['d', marker],
          ['expiration', String(createdAt + PROBE_EXPIRATION_SEC)],
        ],
        content: marker,
      },
      secretKey,
    );
    const handshake = finalizeEvent(
      {
        kind: EVENT_KIND_DATA_TRANSFER,
        created_at: createdAt,
        tags: [['d', marker]],
        content: marker,
      },
      secretKey,
    );

    try {
      socket = new WebSocket(url);
    } catch (error) {
      connect.status = 'failed';
      connect.detail = error instanceof Error ? error.message : 'refused';
      finish();
      return;
    }

    socket.onopen = () => {
      opened = true;
      connect.status = 'ok';
      connect.detail = `${Date.now() - started}ms`;
      socket?.send(JSON.stringify(['EVENT', rendezvous]));
      socket?.send(JSON.stringify(['EVENT', handshake]));
    };

    socket.onerror = () => {
      // Browsers withhold the reason from page script, so this only records
      // that the socket failed; the close event follows with what detail
      // there is and overwrites this with the better text.
      if (connect.status === 'skipped') {
        connect.status = 'failed';
        connect.detail = 'connection failed';
      }
    };

    socket.onclose = (event) => {
      const reason = event.reason || `closed (code ${event.code})`;
      if (!opened) {
        connect.status = 'failed';
        connect.detail = reason;
      }
      for (const step of steps) {
        if (step === connect || step.status !== 'skipped' || step.detail) {
          continue;
        }
        // A step the socket outlived genuinely failed; one that never got a
        // socket to run on was not attempted, and saying it "failed" would
        // report four problems where the relay has one.
        step.status = opened ? 'failed' : 'skipped';
        step.detail = opened ? reason : 'not attempted';
      }
      finish();
    };

    socket.onmessage = (message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      const [type] = frame as [string, ...unknown[]];

      if (type === 'OK') {
        const [, id, accepted, reason] = frame as [
          string,
          string,
          boolean,
          string | undefined,
        ];
        const step = id === rendezvous.id ? writeRendezvous : writeHandshake;
        if (id !== rendezvous.id && id !== handshake.id) return;
        step.status = accepted ? 'ok' : 'failed';
        step.detail = accepted ? undefined : reason || 'rejected';
        if (id === rendezvous.id) {
          if (accepted) {
            socket?.send(
              JSON.stringify([
                'REQ',
                'readback',
                {
                  kinds: [EVENT_KIND_RENDEZVOUS],
                  authors: [publicKey],
                  '#d': [marker],
                  limit: 1,
                },
              ]),
            );
          } else {
            readBack.status = 'skipped';
            readBack.detail = 'the write was refused';
          }
        }
      } else if (type === 'EVENT') {
        const [, subscription, event] = frame as [
          string,
          string,
          { id?: string },
        ];
        if (subscription === 'readback' && event?.id === rendezvous.id) {
          readBack.status = 'ok';
        }
      } else if (type === 'EOSE') {
        if (readBack.status === 'skipped' && !readBack.detail) {
          readBack.status = 'failed';
          // The relay acknowledged the write and then did not serve it: the
          // failure a connect-only check can never see.
          readBack.detail = 'acknowledged but not served';
        }
      } else if (type === 'CLOSED') {
        const [, , reason] = frame as [string, string, string | undefined];
        if (readBack.status === 'skipped') {
          readBack.status = 'failed';
          readBack.detail = reason || 'subscription refused';
        }
      }

      // Done once nothing is still outstanding.
      if (steps.every((step) => step.status !== 'skipped' || step.detail)) {
        finish();
      }
    };
  });
}

/**
 * Probe a whole pool at once. Every relay is reported, in the order given,
 * whichever way it went — naming the failures is the point.
 */
export async function probeSignalingRelays(
  urls: readonly string[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<RelayProbeResult[]> {
  const canonical = [
    ...new Set(
      urls.map(normalizeRelayUrl).filter((url): url is string => url !== null),
    ),
  ];
  return Promise.all(
    canonical.map((url) => probeSignalingRelay(url, timeoutMs)),
  );
}
