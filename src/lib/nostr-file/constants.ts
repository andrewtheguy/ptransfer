// Experimental Nostr file relay (store-and-forward for Manual Exchange).

// Hard cap on the plaintext payload relayed through nostr events.
export const NOSTR_FILE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

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

export const NOSTR_FILE_MANIFEST_VERSION = 1;

// Codec identity: deflate then AES-256-GCM (nonce||ct||tag) then Z85.
export const NOSTR_FILE_ENCRYPTION_LABEL = 'deflate+aes-256-gcm';
export const NOSTR_FILE_AAD_PREFIX = 'ptransfer-nostr-file:v1';

// Relay batch selected per upload; every chunk is broadcast to the whole
// batch (redundancy, not sharding).
export const UPLOAD_RELAY_COUNT = 6;

// A chunk counts as saved once this many relays acknowledged it.
export const MIN_CHUNK_RELAY_SUCCESS = 2;

// Per-relay publish retry policy.
export const PUBLISH_MAX_RETRIES = 3;
export const PUBLISH_BACKOFF_BASE_MS = 500;
export const PUBLISH_BACKOFF_CAP_MS = 5000;
export const PUBLISH_BACKOFF_JITTER_MS = 250;

export const UPLOAD_CHUNK_CONCURRENCY = 8;

export const HEALTH_CHECK_CONCURRENCY = 12;
export const HEALTH_CHECK_TIMEOUT_MS = 8000;
// Stop health-checking once this many relays passed (rotation headroom over
// UPLOAD_RELAY_COUNT without probing the entire candidate list).
export const HEALTH_CHECK_TARGET_COUNT = UPLOAD_RELAY_COUNT * 2;

// NIP-66 / NIP-65 discovery query limit per kind.
export const DISCOVERY_CANDIDATE_LIMIT = 100;
export const DISCOVERY_CANDIDATE_CAP = 150;

// Max `d` identifiers per fetch filter.
export const D_TAG_FILTER_BATCH = 100;

export const RELAY_QUERY_MAX_WAIT_MS = 10000;

export const RELAY_POOL_STORAGE_KEY = 'ptransfer:nostr-file:relay-pool:v1';
export const RELAY_CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;

// Tolerated wall-clock disagreement between sender and receiver.
export const CLOCK_SKEW_TOLERANCE_SEC = 600;
