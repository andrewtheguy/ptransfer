// PIN generation
export const PIN_LENGTH = 12;
export const PIN_CHECKSUM_LENGTH = 1; // Last character is checksum

// The original case-sensitive PIN alphabet excludes ambiguous characters
// (0, 1, I, O, i, l, o) and includes symbols available on the iOS "123"
// keyboard.
export const PIN_CHARSET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789-/:;()$&@?!.,"';

// PIN rotation. The sender mints a fresh PIN and publishes a new rendezvous
// event every PIN_ROTATION_MS. Claims are honored only for PINs published in
// the sender's current or immediately previous wall-clock rotation bucket.
// PIN_TTL_MS is the maximum possible age of such a PIN; exact expiry occurs at
// the end of its second bucket.
export const PIN_ROTATION_MS = 300_000;
export const PIN_ACTIVE_BUCKETS = 2;
export const PIN_TTL_MS = PIN_ROTATION_MS * PIN_ACTIVE_BUCKETS;

// How many earlier rotation buckets the receiver derives hints for when
// locating the rendezvous event. This mirrors the sender's exact acceptance
// rule: derive the current bucket and the immediately previous bucket.
export const PIN_HINT_LOOKBACK_BUCKETS = PIN_ACTIVE_BUCKETS - 1;

// PBKDF2 parameters for the PIN root derivation (browser-native alternative to
// a memory-hard KDF). The PIN no longer derives any content-encryption keys —
// those come from an ephemeral ECDH exchange — so the KDF only has to make
// brute-forcing a captured rendezvous record slow relative to the ~PIN_TTL_MS
// window in which a recovered PIN is useful (before the first claim locks the
// transfer to one receiver).
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_HASH = 'SHA-256';

// Domain-separation salt for the PBKDF2 PIN-root derivation. Public constant:
// it defeats generic precomputed-hash tables while letting both sides derive
// the same root from the same PIN.
export const PIN_ROOT_SALT = 'secure-send:pin-root:v2';

// HKDF salt shared by every derivation off the PIN root; each purpose is
// domain-separated by its HKDF info label ('hint:<bucket>', 'auth',
// 'rendezvous') so no two purposes ever share a key.
export const PIN_HKDF_SALT = 'secure-send:pin:v2';

// The on-screen PIN fingerprint is never transmitted — it exists only for
// human visual comparison — so it uses its own deliberately light stretch
// instead of the full PIN-root work factor, cheap enough to show the moment
// the PIN is typed.
export const PIN_FINGERPRINT_ITERATIONS = 1_000;
export const PIN_FINGERPRINT_SALT = 'secure-send:pin-fingerprint:v2';

// AES-GCM parameters
export const AES_KEY_LENGTH = 256; // bits
export const AES_NONCE_LENGTH = 12; // bytes (96 bits)
export const AES_TAG_LENGTH = 16; // bytes (128 bits)

// Salt length
export const SALT_LENGTH = 16;

// Encryption chunk size for P2P transfers
// 128KB chunks, each encrypted with unique nonce
// WebRTC data channel has ~256KB message limit, so 128KB + encryption overhead stays safe
export const ENCRYPTION_CHUNK_SIZE = 128 * 1024; // 128KB

// Max size of a transferred payload (file or generated ZIP archive). Every
// stage streams — multi-file/folder sends are zipped directly into the data
// channel, the sender encrypts lazy 128KB source chunks, and the receiver
// writes decrypted chunks to scratch storage — so the bound comes
// from the 2-byte chunk-index range and disk quota, not RAM. Payloads over
// MEMORY_SINK_MAX_BYTES require OPFS; browsers without it cannot transfer
// them.
export const MAX_MESSAGE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

// Payloads at or below this size are buffered in memory during transfer;
// larger payloads require OPFS scratch storage.
export const MEMORY_SINK_MAX_BYTES = 100 * 1024 * 1024; // 100MB

// PIN hint length.
// 16 hex chars = 64 bits. The hint is the Nostr `#h` filter tag. 64 bits is
// birthday-collision-free at any realistic concurrent-transfer scale. Deriving
// it requires the full PBKDF2 PIN-root stretch, so it cannot be reversed to a
// PIN faster than brute-forcing the PIN space.
export const PIN_HINT_LENGTH = 16; // hex characters

// PIN fingerprint length.
// 12 lowercase hex chars = 48 bits. The fingerprint is local-only and exists
// solely for two humans to visually compare on-device that they entered the
// same PIN. It is not a collision-resistance primitive and never crosses the
// network, so 48 bits is more than enough to make an accidental match between
// two distinct PINs negligible while keeping the displayed value short and
// easy to read aloud.
export const PIN_FINGERPRINT_LENGTH = 12; // lowercase hex characters

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000; // 1 hour (manual-exchange session TTL)
// Resource backstop, not a security control: rotation already caps any single
// PIN's exposure at PIN_TTL_MS, so waiting longer is not less safe. This only
// bounds how long an unclaimed transfer keeps publishing rendezvous events and
// holding the file in memory before giving up.
export const PIN_WAIT_TIMEOUT_MS = 30 * 60 * 1000; // Total time the sender keeps rotating/waiting before giving up (30 minutes)
