// Nostr file relay: the Code Exchange fallback data path, used when the
// direct WebRTC connection between the two devices cannot be established
// (a live single-copy transfer through public relays, in place of TURN).

// The cap on a relayed payload is SLOW_TRANSPORT_MAX_BYTES in
// lib/crypto/constants.ts, shared with the Tor onion transport: both carry
// bytes through third parties, at a fraction of a data channel's speed, with
// no resume if the transfer dies partway.

// Payload chunk size (a single-file payload is always deflated once; an
// already-compressed generated ZIP archive travels unchanged). Encoded
// content per event is bounded by z85(chunk + 12 B nonce + 16 B tag) =
// 61,475 B (~60 KiB), just under the ~63 KiB content size measured against
// the public relay population — relays that cap lower fail the full-size
// health probe.
export const NOSTR_FILE_CHUNK_SIZE = 49152;

// NIP-78 addressable event kind used for chunk (and probe) events.
export const EVENT_KIND_FILE_CHUNK = 30078;

// NIP-40 lifetime stamped on every published event, probes included. The
// whole point of this mode is that relays never hold the data longer than one
// transfer window.
export const NOSTR_FILE_EXPIRATION_SEC = 3600; // 1 hour

export const NOSTR_FILE_MANIFEST_VERSION = 7;

// Codec identity: whole-payload deflate for a single file, or identity for an
// already-compressed generated ZIP, then per-chunk AES-256-GCM
// (nonce||ct||tag) and Z85.
export const NOSTR_FILE_ENCRYPTION_LABEL = 'aes-256-gcm';
export const NOSTR_FILE_AAD_PREFIX = 'ptransfer-nostr-file:v1';

// Relay batch selected per upload. Chunks are spread across the batch: chunk
// i is placed on one relay starting at relays[i % N], walking the ring on
// rejection, so each relay stores only ~1/N of the file.
export const UPLOAD_RELAY_COUNT = 16;

// Fewer usable relays than this and an upload refuses to start.
export const MIN_UPLOAD_RELAYS = 2;

// Per-relay publish retry policy.
export const PUBLISH_MAX_RETRIES = 3;
export const PUBLISH_BACKOFF_BASE_MS = 500;
export const PUBLISH_BACKOFF_CAP_MS = 5000;
export const PUBLISH_BACKOFF_JITTER_MS = 250;

export const UPLOAD_CHUNK_CONCURRENCY = 16;

export const HEALTH_CHECK_CONCURRENCY = 16;
export const HEALTH_CHECK_TIMEOUT_MS = 8000;
// Stop health-checking once the storage ring has passed, without probing the
// entire candidate list (only ~1 in 6 public candidates passes the full-size
// probe). A Code Exchange whose default signaling relays are defunct probes
// only until the gap in its control set is filled, before the code is shown.
export const HEALTH_CHECK_TARGET_COUNT = UPLOAD_RELAY_COUNT;
// Probe payload size. A full-size chunk, so a relay that caps event size below
// a real chunk fails the probe instead of rejecting every chunk placed on it.
export const HEALTH_CHECK_PROBE_BYTES = NOSTR_FILE_CHUNK_SIZE;

// Once the ring is full the foreground health check stops, and the rest of the
// relay population would never be looked at. A background sweep runs behind
// the upload instead: it enumerates every relay it can find (uncapped, unlike
// the foreground pass) and probes as far as the transfer lasts, so the next
// transfer starts from a cache of the whole population. It shares the
// upload's bandwidth, so it stays well below HEALTH_CHECK_CONCURRENCY.
export const BACKGROUND_PROBE_CONCURRENCY = 4;
// Sweep outcomes are written to IndexedDB in batches of this size (plus a
// final flush), so a page closed mid-sweep still keeps most of the work.
export const BACKGROUND_PROBE_SAVE_BATCH = 8;

// The encrypted control channel rides the proven relays the offer names for
// the file-relay fallback. DEFAULT_RELAYS are checked with a small probe
// first; a default that fails is filled from a discovered relay that passed
// the full-size HEALTH_CHECK_PROBE_BYTES probe (probing stops once the gap is
// filled), not from a control-sized discovery.
export const CONTROL_RELAY_COUNT = 6;
// Fewer usable control relays than this and the offer goes out without
// relays — no relay fallback.
export const MIN_CONTROL_RELAYS = 2;
// Control probe payload size — a sealed control message is a few hundred
// bytes, so a size-capped relay that would reject chunks may still pass.
export const CONTROL_PROBE_BYTES = 256;
// Control probes race all seeds concurrently and the check waits out every
// in-flight probe, so a dead seed delays code handout by this full amount —
// keep it short.
export const CONTROL_PROBE_TIMEOUT_MS = 4000;

// NIP-66 / NIP-65 discovery query limit per kind for the foreground pass. It
// only has to fill one ring, so it takes a single page and moves on.
export const DISCOVERY_CANDIDATE_LIMIT = 100;
// Candidates a single transfer will rank and health-check. A bound on the
// working set, not on what is known: the cache holds far more (see
// RELAY_CACHE_MAX_ENTRIES) and the best of it leads this list.
export const DISCOVERY_CANDIDATE_CAP = 150;

// The background pass enumerates instead of sampling: it pages back through
// NIP-66/NIP-65 history by `created_at` until a page turns up nothing new.
// These bound the paging, not the result — discovery itself is uncapped.
export const DISCOVERY_PAGE_LIMIT = 500;
export const DISCOVERY_MAX_PAGES = 20;
export const DISCOVERY_PAGE_MAX_WAIT_MS = 8000;

// Max `d` identifiers per fetch filter (~3 MiB of content per query).
export const D_TAG_FILTER_BATCH = 50;

export const RELAY_QUERY_MAX_WAIT_MS = 15000;

// The sender uploads each chunk to one relay and announces availability over
// an encrypted control channel; the receiver acknowledges and only pieces it
// could not fetch are sent again.
//
// Chunks per availability announcement (64 × 48 KiB = 3 MiB).
export const LIVE_BATCH_CHUNKS = 64;
// The sender re-announces its latest availability when nothing changed, so a
// lost announcement or acknowledgement is recovered on the next beat.
export const LIVE_HEARTBEAT_MS = 15000;
// Either side gives up when the peer has been silent this long (after the
// peer was seen at least once).
export const LIVE_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
// Floor on how many times one chunk may be re-sent before the transfer fails.
export const LIVE_MIN_RETRANSMITS_PER_CHUNK = 4;
// Receiver retry clock. A piece still missing this long after its last fetch
// attempt is fetched again from the same placement (a transient failure —
// slow relay, reconnect, propagation delay — recovers without burning a
// re-send), and the receiver runs a fetch cycle on this clock even when no
// new announcement arrives, so a timed-out piece is re-fetched and re-asked
// instead of waiting on the sender forever.
export const LIVE_FETCH_RETRY_MS = 10_000;
// A relay the receiver reports this many misses against (it acknowledged the
// chunk but does not serve it) stops receiving new chunks and re-sends.
export const LIVE_RELAY_DEMOTE_MISSES = 2;
// A relay that gives up this many publishes (every retry rejected) is demoted
// too: each chunk whose ring walk starts there otherwise burns the whole
// retry-with-backoff schedule before moving on.
export const LIVE_RELAY_DEMOTE_GIVEUPS = 3;
// HKDF info label for the control-channel key derived from the file key.
export const CONTROL_KEY_INFO = 'ptransfer-nostr-file:v1:control';
// HKDF info label for the relay session (transfer id + file key) both sides
// derive from the Code Exchange ECDH shared secret.
export const RELAY_SESSION_INFO = 'ptransfer-nostr-file:v1:session';
// Decompression bound for a control message body (a full ~2100-chunk map
// with every chunk listed is well under this).
export const CONTROL_MESSAGE_MAX_BYTES = 256 * 1024;

export const RELAY_CACHE_DATABASE_NAME = 'ptransfer:nostr-file:relay-cache';
export const RELAY_CACHE_DATABASE_VERSION = 2;
export const RELAY_CACHE_STATE_STORE = 'relay-pool-state';
export const RELAY_CACHE_HEALTH_STORE = 'relay-health';
// Lifetime of a discovery or a failed verdict. A healthy relay is exempt and
// stays cached until it fails: it is what a start with dead seeds runs on, and
// it is probed again before it carries anything, so an old verdict costs one
// probe, never a transfer.
export const RELAY_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Relays retained in the health cache — the record of everything the
// background pass has found, proved, or buried. Deliberately far above
// DISCOVERY_CANDIDATE_CAP: each transfer draws its working set from here, so
// capping this at the working-set size would throw the enumeration away.
export const RELAY_CACHE_MAX_ENTRIES = 2000;

// Tolerated wall-clock disagreement between sender and receiver.
export const CLOCK_SKEW_TOLERANCE_SEC = 600;
