import { type Event, finalizeEvent } from 'nostr-tools';
import { wipeBufferSource } from '../crypto/memory';
import { chunkAad, encodeChunkContent } from '../nostr-file/codec';
import { CONTROL_PROBE_BYTES } from '../nostr-file/constants';
import { buildProbeEvent } from '../nostr-file/events';
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

const PIN_READ_BACK_SUB = 'pin-readback';
const CODE_READ_BACK_SUB = 'code-readback';

export type RelayProbeStatus = 'ok' | 'failed' | 'skipped';

export interface RelayProbeStep {
  /** What was attempted, in the order the transfer itself would attempt it. */
  label: string;
  status: RelayProbeStatus;
  /** Round-trip time, the relay's own rejection reason, or why it was skipped. */
  detail?: string;
}

/** One transfer method's requirements, checked end to end. */
export interface RelayCheck {
  /** The method this proves the relay can carry. */
  label: string;
  /** Every step passed. */
  passed: boolean;
  /** Time from the probe's start to this check's last step, or null if it failed. */
  rttMs: number | null;
  steps: RelayProbeStep[];
}

export interface RelayProbeResult {
  url: string;
  /** Shared precondition: both checks need this same socket. */
  connect: RelayProbeStep;
  /** PIN Exchange signaling: both signaling kinds written, rendezvous read back. */
  pinExchange: RelayCheck;
  /** Code Exchange's encrypted control channel: a chunk-kind write read back. */
  codeExchange: RelayCheck;
}

/**
 * Does this relay actually work — and for which transfer method?
 *
 * The two methods ask different things of a relay, so one verdict cannot
 * answer for both. PIN Exchange puts the peers in touch over the signaling
 * kinds: a retained kind-4243 rendezvous and an ephemeral kind-24243
 * handshake. Code Exchange carries no signaling on a relay at all — the code
 * is hand-carried — but its relay fallback runs an encrypted control channel
 * over the chunk kind. Nothing makes a relay treat those alike: an allowlist
 * can name one set of kinds and not the other, the control event is far
 * larger, and a rendezvous has to be retained where an addressable chunk is
 * replaced. Every relay sampled so far has been all-or-nothing across the
 * three kinds, so this is a difference that can exist rather than one
 * observed in the wild — which is the point of measuring instead of assuming.
 * A relay that is simply reachable proves neither: it can accept the
 * connection and still refuse the kinds, or acknowledge a write and never
 * serve it.
 *
 * So both suites run over one socket, under one throwaway key, in the shapes
 * production uses. What a relay can carry is then a fact about that relay
 * rather than a guess from whichever transfer happened to touch it last.
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
  if (result.connect.status === 'failed') {
    result.connect.detail = await describeConnectFailure(
      url,
      result.connect.detail,
    );
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

interface ProbeEvents {
  rendezvous: Event;
  handshake: Event;
  chunk: Event;
  publicKey: string;
  /** `d` tag of the rendezvous, so the read-back filter can name it. */
  marker: string;
  /** `d` tag of the control-channel event. */
  chunkDTag: string;
  /** Encoded content of the control event, to compare what comes back against. */
  chunkContent: string;
}

/**
 * Build all three events under one throwaway key, in the shapes production
 * publishes. The control event goes through the real chunk codec
 * (`buildProbeEvent`, AES-GCM then Z85) rather than a stand-in, so what the
 * relay sees — kind, tags, encoding, size — is what a real transfer would put
 * on it, and stays that way if the codec changes.
 */
async function buildProbeEvents(): Promise<ProbeEvents> {
  const { secretKey, publicKey } = generateEphemeralKeys();
  try {
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

    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const aesKey = await crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      'AES-GCM',
      false,
      ['encrypt'],
    );
    wipeBufferSource(keyBytes);
    // CONTROL_PROBE_BYTES, not a full chunk: the control channel is what Code
    // Exchange needs a relay for, and it is what `resolveTransferRelays`
    // probes with, so this asks the same question of the same relay.
    const payload = crypto.getRandomValues(new Uint8Array(CONTROL_PROBE_BYTES));
    const chunkContent = await encodeChunkContent(
      aesKey,
      payload,
      chunkAad('probe', 0, 1),
    );
    const { event: chunk, dTag: chunkDTag } = buildProbeEvent(
      secretKey,
      chunkContent,
    );

    return {
      rendezvous,
      handshake,
      chunk,
      publicKey,
      marker,
      chunkDTag,
      chunkContent,
    };
  } finally {
    wipeBufferSource(secretKey);
  }
}

async function runSocketProbe(
  url: string,
  timeoutMs: number,
): Promise<RelayProbeResult> {
  const events = await buildProbeEvents();
  return new Promise((resolve) => {
    const started = Date.now();
    const connect: RelayProbeStep = { label: 'connect', status: 'skipped' };
    const writeRendezvous: RelayProbeStep = {
      label: `write kind ${EVENT_KIND_RENDEZVOUS} (rendezvous)`,
      status: 'skipped',
    };
    const writeHandshake: RelayProbeStep = {
      label: `write kind ${EVENT_KIND_DATA_TRANSFER} (handshake)`,
      status: 'skipped',
    };
    const readRendezvous: RelayProbeStep = {
      label: 'read the rendezvous back',
      status: 'skipped',
    };
    const writeControl: RelayProbeStep = {
      label: `write kind ${events.chunk.kind} (control message)`,
      status: 'skipped',
    };
    const readControl: RelayProbeStep = {
      label: 'read the control message back',
      status: 'skipped',
    };
    const pinSteps = [writeRendezvous, writeHandshake, readRendezvous];
    const codeSteps = [writeControl, readControl];
    const steps = [connect, ...pinSteps, ...codeSteps];

    // When each suite finished, so a check that passes early is not charged
    // for the other one still running.
    let pinMs: number | null = null;
    let codeMs: number | null = null;
    const noteIfDone = (own: RelayProbeStep[], set: (ms: number) => void) => {
      if (own.every((step) => step.status === 'ok')) set(Date.now() - started);
    };

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
      const check = (
        label: string,
        own: RelayProbeStep[],
        rttMs: number | null,
      ): RelayCheck => {
        const passed =
          connect.status === 'ok' && own.every((step) => step.status === 'ok');
        return { label, passed, rttMs: passed ? rttMs : null, steps: own };
      };
      resolve({
        url,
        connect,
        pinExchange: check('PIN Exchange signaling', pinSteps, pinMs),
        codeExchange: check('Code Exchange control', codeSteps, codeMs),
      });
    };
    const timer = setTimeout(() => {
      for (const step of steps) {
        if (step.status !== 'skipped' || step.detail) continue;
        // Same rule as a close: a socket that never opened leaves one
        // problem, not six. Only steps that had a socket to run on can be
        // said to have timed out.
        const attempted = step === connect || opened;
        step.status = attempted ? 'failed' : 'skipped';
        step.detail = attempted ? 'timed out' : 'not attempted';
      }
      finish();
    }, timeoutMs);

    try {
      socket = new WebSocket(url);
    } catch (error) {
      connect.status = 'failed';
      connect.detail = error instanceof Error ? error.message : 'refused';
      finish();
      return;
    }

    const send = (frame: unknown) => socket?.send(JSON.stringify(frame));

    socket.onopen = () => {
      opened = true;
      connect.status = 'ok';
      connect.detail = `${Date.now() - started}ms`;
      send(['EVENT', events.rendezvous]);
      send(['EVENT', events.handshake]);
      send(['EVENT', events.chunk]);
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
        // report six problems where the relay has one.
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
        const write =
          id === events.rendezvous.id
            ? writeRendezvous
            : id === events.handshake.id
              ? writeHandshake
              : id === events.chunk.id
                ? writeControl
                : null;
        if (!write) return;
        write.status = accepted ? 'ok' : 'failed';
        write.detail = accepted ? undefined : reason || 'rejected';

        // Only a write that landed can be read back; a refused one leaves the
        // read with nothing to prove.
        if (id === events.rendezvous.id) {
          if (accepted) {
            send([
              'REQ',
              PIN_READ_BACK_SUB,
              {
                kinds: [EVENT_KIND_RENDEZVOUS],
                authors: [events.publicKey],
                '#d': [events.marker],
                limit: 1,
              },
            ]);
          } else {
            readRendezvous.status = 'skipped';
            readRendezvous.detail = 'the write was refused';
          }
        } else if (id === events.chunk.id) {
          if (accepted) {
            send([
              'REQ',
              CODE_READ_BACK_SUB,
              {
                kinds: [events.chunk.kind],
                authors: [events.publicKey],
                '#d': [events.chunkDTag],
                limit: 1,
              },
            ]);
          } else {
            readControl.status = 'skipped';
            readControl.detail = 'the write was refused';
          }
        }
        noteIfDone(pinSteps, (ms) => {
          pinMs = ms;
        });
        noteIfDone(codeSteps, (ms) => {
          codeMs = ms;
        });
      } else if (type === 'EVENT') {
        const [, subscription, event] = frame as [
          string,
          string,
          { id?: string; content?: string },
        ];
        if (
          subscription === PIN_READ_BACK_SUB &&
          event?.id === events.rendezvous.id
        ) {
          readRendezvous.status = 'ok';
          noteIfDone(pinSteps, (ms) => {
            pinMs = ms;
          });
        } else if (subscription === CODE_READ_BACK_SUB) {
          if (event?.id !== events.chunk.id) return;
          // Byte-identical content is the whole test: the codec round trip is
          // already proven locally, so what is in question is whether the
          // relay stored and served the payload intact.
          const intact = event.content === events.chunkContent;
          readControl.status = intact ? 'ok' : 'failed';
          if (!intact) readControl.detail = 'served altered content';
          noteIfDone(codeSteps, (ms) => {
            codeMs = ms;
          });
        }
      } else if (type === 'EOSE') {
        const [, subscription] = frame as [string, string];
        const read =
          subscription === PIN_READ_BACK_SUB
            ? readRendezvous
            : subscription === CODE_READ_BACK_SUB
              ? readControl
              : null;
        if (read?.status === 'skipped' && !read.detail) {
          read.status = 'failed';
          // The relay acknowledged the write and then did not serve it: the
          // failure a connect-only check can never see.
          read.detail = 'acknowledged but not served';
        }
      } else if (type === 'CLOSED') {
        const [, subscription, reason] = frame as [
          string,
          string,
          string | undefined,
        ];
        const read =
          subscription === PIN_READ_BACK_SUB
            ? readRendezvous
            : subscription === CODE_READ_BACK_SUB
              ? readControl
              : null;
        if (read?.status === 'skipped') {
          read.status = 'failed';
          read.detail = reason || 'subscription refused';
        }
      }

      // Done once nothing is still outstanding.
      if (steps.every((step) => step.status !== 'skipped' || step.detail)) {
        finish();
      }
    };
  });
}

/** A relay URL typed or pasted by hand that could not be used. */
export interface RejectedRelayInput {
  /** Exactly what was typed, so the person can see which entry it was. */
  raw: string;
  reason: string;
}

export interface ParsedRelayInput {
  /** Canonical, deduplicated, in the order first seen. */
  relays: string[];
  rejected: RejectedRelayInput[];
}

/** Whitespace and commas both separate entries, so a pasted list just works. */
const INPUT_SEPARATORS = /[\s,]+/;

/**
 * Turn typed or pasted text into relay URLs to probe.
 *
 * Rejections are returned rather than dropped. Silently ignoring an entry is
 * the exact failure this page exists to cure: someone would type a relay,
 * watch it not appear, and have no way to tell a URL this app refused from a
 * relay that failed its probe.
 */
export function parseRelayInput(text: string): ParsedRelayInput {
  const relays: string[] = [];
  const rejected: RejectedRelayInput[] = [];
  const seen = new Set<string>();
  for (const token of text.split(INPUT_SEPARATORS)) {
    // Pasting from a source file or a JSON list brings the punctuation along.
    const raw = token.replace(/^["'[\]]+|["'[\],]+$/g, '').trim();
    if (!raw) continue;
    // A bare hostname is what people type, and a relay URL has exactly one
    // plausible scheme. This leniency belongs at the typed-input boundary and
    // nowhere else: `normalizeRelayUrl` also vets lists arriving from the
    // network, where guessing at what a malformed entry meant would be wrong.
    //
    // The dot is what keeps it from being too lenient. `wss://` in front of a
    // single word produces a URL this app would accept as a relay, so a
    // sentence typed into the box would come back as a list of hostnames to
    // probe; a public relay always has a dotted name.
    const candidate =
      raw.includes('://') || raw.includes('.') ? withScheme(raw) : raw;
    const url = normalizeRelayUrl(candidate);
    if (url === null) {
      rejected.push({ raw, reason: describeRejectedInput(candidate) });
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    relays.push(url);
  }
  return { relays, rejected };
}

function withScheme(raw: string): string {
  return raw.includes('://') ? raw : `wss://${raw}`;
}

function describeRejectedInput(candidate: string): string {
  let host: string;
  try {
    host = new URL(candidate).hostname;
  } catch {
    return 'not a URL';
  }
  if (host.endsWith('.onion')) {
    // Probing it from here would open the clearnet socket the anonymous mode
    // exists to avoid, so refusing it is the feature, not a gap.
    return 'onion relay — reachable only through Tor, so not checked here';
  }
  return 'not a usable wss:// relay URL';
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
