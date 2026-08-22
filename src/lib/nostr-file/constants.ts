// Experimental Nostr file relay (live single-copy transfer for Manual
// Exchange).

// Hard cap on the plaintext payload relayed through nostr events.
export const NOSTR_FILE_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB

// Plaintext chunk size. Encoded content per event is bounded by
// z85((chunk + deflate overhead) + 12B nonce + 16B tag) ~= 41 KB for
// incompressible data, comfortably under the ~64 KB content size the public
// relay population is known to accept.
export const NOSTR_FILE_CHUNK_SIZE = 32768;

// NIP-78 addressable event kind used for chunk (and probe) events.
export const EVENT_KIND_FILE_CHUNK = 30078;

// NIP-40 lifetime stamped on every published event, probes included. The
// whole point of this mode is that relays never hold the data longer than one
// transfer window.
export const NOSTR_FILE_EXPIRATION_SEC = 3600; // 1 hour

export const NOSTR_FILE_MANIFEST_VERSION = 3;

// Codec identity: deflate then AES-256-GCM (nonce||ct||tag) then Z85.
export const NOSTR_FILE_ENCRYPTION_LABEL = 'deflate+aes-256-gcm';
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
// Stop health-checking once this many relays passed: some rotation headroom
// over UPLOAD_RELAY_COUNT without probing the entire candidate list (only
// ~1 in 6 public candidates passes the full-size probe).
export const HEALTH_CHECK_TARGET_COUNT = UPLOAD_RELAY_COUNT + 4;
// Probe payload size. A full-size chunk, so a relay that caps event size below
// a real chunk fails the probe instead of rejecting every chunk placed on it.
export const HEALTH_CHECK_PROBE_BYTES = NOSTR_FILE_CHUNK_SIZE;

// NIP-66 / NIP-65 discovery query limit per kind.
export const DISCOVERY_CANDIDATE_LIMIT = 100;
export const DISCOVERY_CANDIDATE_CAP = 150;

// Max `d` identifiers per fetch filter (~2 MB of content per query).
export const D_TAG_FILTER_BATCH = 50;

export const RELAY_QUERY_MAX_WAIT_MS = 15000;

// The sender uploads each chunk to one relay and announces availability over
// an encrypted control channel; the receiver acknowledges and only pieces it
// could not fetch are sent again.
//
// Chunks per availability announcement (64 × 32 KiB = 2 MiB).
export const LIVE_BATCH_CHUNKS = 64;
// The sender re-announces its latest availability when nothing changed, so a
// lost announcement or acknowledgement is recovered on the next beat.
export const LIVE_HEARTBEAT_MS = 15000;
// Either side gives up when the peer has been silent this long (after the
// peer was seen at least once).
export const LIVE_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
// Floor on how many times one chunk may be re-sent before the transfer fails.
export const LIVE_MIN_RETRANSMITS_PER_CHUNK = 4;
// A relay the receiver reports this many misses against (it acknowledged the
// chunk but does not serve it) stops receiving new chunks and re-sends.
export const LIVE_RELAY_DEMOTE_MISSES = 2;
// HKDF info label for the control-channel key derived from the file key.
export const CONTROL_KEY_INFO = 'ptransfer-nostr-file:v1:control';
// Decompression bound for a control message body (a full 3200-chunk map
// with every chunk listed is well under this).
export const CONTROL_MESSAGE_MAX_BYTES = 256 * 1024;

export const RELAY_POOL_STORAGE_KEY = 'ptransfer:nostr-file:relay-pool:v1';
export const RELAY_CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;

// Tolerated wall-clock disagreement between sender and receiver.
export const CLOCK_SKEW_TOLERANCE_SEC = 600;
