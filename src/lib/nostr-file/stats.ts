/**
 * Detailed transfer statistics for the Nostr file relay flow (both roles).
 * One mutable accumulator is created per transfer and threaded through the
 * relay/codec layers, which bump counters in place;
 * every progress callback carries the same object so the UI always renders
 * the current totals. Byte counters measure event *content* (the Z85 text),
 * not the surrounding event JSON, so overhead ratios compare what the codec
 * and re-sends actually cost against the raw file size.
 */

export interface NostrFileRelayStats {
  url: string;
  /**
   * The job this relay does for the transfer: 'control' carries the sealed
   * signaling messages, 'storage' holds chunks. The sets never overlap.
   */
  role: 'control' | 'storage';
  /** Health-probe write→read round trip, ms (probed relays only). */
  rttMs?: number;
  /** Publish attempts, retries included (chunks or control messages). */
  publishAttempts: number;
  /** Events this relay acknowledged (chunks or control messages). */
  eventsAccepted: number;
  /** Publishes given up after all retries. */
  publishesFailed: number;
  /** Content bytes this relay accepted (encoded chunks or sealed control). */
  bytesUp: number;
  /** Receiver: chunk queries sent to this relay. */
  queries: number;
  /** Receiver: queries that errored or timed out. */
  queryFailures: number;
  /** Receiver: chunk events this relay returned (duplicates included). */
  eventsReceived: number;
  /** Receiver: encoded content bytes received (duplicates included). */
  bytesDown: number;
  /** Receiver: chunks this relay actually supplied. */
  chunksSupplied: number;
  /** Receiver: events that failed to parse or decrypt. */
  corruptEvents: number;
  /** Sender: receiver-reported misses against this relay. */
  missesReported: number;
  /** Sender: demoted after repeated misses. */
  demoted: boolean;
}

export interface NostrFileTransferStats {
  role: 'sender' | 'receiver';
  fileBytes: number;
  /** Bytes chunked onto relays: deflated for a single file, or unchanged for
   * an already-compressed generated ZIP archive. */
  payloadBytes: number;
  chunkSize: number;
  chunksTotal: number;
  /** Sender: encoded size of one copy of every chunk (codec output). */
  encodedBytes: number;
  /** Sender: chunk-event publishes accepted — first placements and re-sends. */
  eventsPublished: number;
  publishAttempts: number;
  publishesFailed: number;
  /** Sender: encoded content bytes accepted by relays. */
  bytesPublished: number;
  /** Sender: chunks re-sent after the receiver reported them missing. */
  chunksResent: number;
  /** Sender: relays demoted for not serving acknowledged writes. */
  relaysDemoted: number;
  /** Receiver: chunk events received (duplicates included). */
  eventsReceived: number;
  bytesReceived: number;
  duplicateEvents: number;
  corruptEvents: number;
  queries: number;
  queryFailures: number;
  /** Receiver: fetch/ack cycles run. */
  ackCycles: number;
  /** Receiver: missing placements reported to the sender. */
  missingReported: number;
  /** Control-channel events published / peer messages unsealed. */
  controlSent: number;
  controlReceived: number;
  /** Relay discovery: candidates found, probed, and passing. */
  candidates: number;
  relaysChecked: number;
  relaysHealthy: number;
  /** Wall-clock phase durations, ms. */
  phaseMs: Partial<
    Record<
      | 'hash'
      | 'compress'
      | 'controlProbe'
      | 'discover'
      | 'healthCheck'
      | 'transfer',
      number
    >
  >;
  /** Control relays first, then ring relays in placement order. */
  relays: NostrFileRelayStats[];
}

export function createRelayStats(
  url: string,
  role: NostrFileRelayStats['role'],
): NostrFileRelayStats {
  return {
    url,
    role,
    publishAttempts: 0,
    eventsAccepted: 0,
    publishesFailed: 0,
    bytesUp: 0,
    queries: 0,
    queryFailures: 0,
    eventsReceived: 0,
    bytesDown: 0,
    chunksSupplied: 0,
    corruptEvents: 0,
    missesReported: 0,
    demoted: false,
  };
}

export function createTransferStats(
  role: NostrFileTransferStats['role'],
): NostrFileTransferStats {
  return {
    role,
    fileBytes: 0,
    payloadBytes: 0,
    chunkSize: 0,
    chunksTotal: 0,
    encodedBytes: 0,
    eventsPublished: 0,
    publishAttempts: 0,
    publishesFailed: 0,
    bytesPublished: 0,
    chunksResent: 0,
    relaysDemoted: 0,
    eventsReceived: 0,
    bytesReceived: 0,
    duplicateEvents: 0,
    corruptEvents: 0,
    queries: 0,
    queryFailures: 0,
    ackCycles: 0,
    missingReported: 0,
    controlSent: 0,
    controlReceived: 0,
    candidates: 0,
    relaysChecked: 0,
    relaysHealthy: 0,
    phaseMs: {},
    relays: [],
  };
}

/**
 * Per-relay entry for `url`, created in place on first use. `role` applies
 * only on creation — the seeding call fixes it, later tallies just find the
 * row (control and storage relays never share a URL).
 */
export function relayStatsFor(
  stats: NostrFileTransferStats,
  url: string,
  role: NostrFileRelayStats['role'],
): NostrFileRelayStats {
  let entry = stats.relays.find((r) => r.url === url);
  if (!entry) {
    entry = createRelayStats(url, role);
    stats.relays.push(entry);
  }
  return entry;
}
