// PIN generation
export const PIN_LENGTH = 12;
export const PIN_CHECKSUM_LENGTH = 1; // Last character is checksum

// The leading PIN_LOCATOR_LENGTH characters are the PIN's *locator* segment.
// They are the only input to the published rendezvous hint, which makes them
// public by construction: a hint has at most PIN_CHARSET.length ** 3 = 328,509
// preimages per rotation bucket, so anyone can enumerate locator -> hint and
// read the locator straight off a relay event.
//
// Splitting the PIN this way is deliberate. The remaining data characters are
// the only entropy the claim/confirm seals and the rendezvous payload rest on,
// so the published tag can never be used to chip away at them; conversely the
// locator alone opens nothing. The honest accounting is that effective offline
// PIN strength is PIN_CHARSET.length ** 8 (about 2^48.9), not ** 11 (2^67.2).
// That is still roughly 5.1e14 PBKDF2_ITERATIONS-strength guesses against a PIN
// that lives 2-4 minutes and is worthless once a claim locks the transfer — and
// the confirmation code (see CONFIRMATION_CODE_LENGTH) is a control that PIN
// recovery cannot defeat at all.
export const PIN_LOCATOR_LENGTH = 3;

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
export const PIN_ROTATION_MS = 120_000;
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

// HKDF salt shared by every PIN-scoped derivation; each purpose is
// domain-separated by its HKDF info label ('hint:<bucket>', 'auth',
// 'rendezvous') so no two purposes ever share a key. Note the key material
// differs by purpose: 'auth' and 'rendezvous' hang off the PBKDF2 PIN root,
// while 'hint:<bucket>' is keyed by the public locator segment directly and
// never touches the root.
export const PIN_HKDF_SALT = 'secure-send:pin:v2';

// Confirmation code: the short authentication string both peers derive from
// the ephemeral ECDH shared secret once a claim is on the table. The receiver
// displays it; the sender's operator types what the receiver reads out, and
// only a match releases the confirm event and the WebRTC offer.
//
// This is what stops a front-runner. Whoever wins the claim race, the sender
// never sends anything until it has been handed a code that only the peer
// holding the matching ECDH private key could have produced — so a PIN that
// leaked off the sender's screen buys an attacker a locked-out session, not a
// file. Because it is keyed by the ECDH shared secret it also proves no relay
// substituted either public key.
//
// 5 bytes = 40 bits = exactly 8 Crockford Base32 characters, short enough to
// read aloud over a phone call and unambiguous when transcribed.
export const CONFIRMATION_CODE_BYTES = 5;
export const CONFIRMATION_CODE_LENGTH = 8;

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
// 8 hex chars of output, but the hint is derived from the locator segment
// alone, so it carries at most log2(PIN_CHARSET.length ** PIN_LOCATOR_LENGTH)
// ~= 18.3 bits and is enumerable by design — it is a public candidate-filtering
// tag, nothing more. The tag width stays at 8 characters because widening it
// costs nothing; the locator caps the real entropy either way.
//
// The practical consequence is collisions: unrelated transfers sharing a bucket
// collide on `#h` at roughly 1 in 328,509 per pair rather than 1 in 2^32, so a
// receiver must expect unrelated candidates and disambiguate them by
// authenticated rendezvous-payload decryption. Query limits on `#h` have to
// leave room for that (see the rendezvous lookup in use-nostr-receive.ts).
export const PIN_HINT_LENGTH = 8; // hex characters

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000; // 1 hour (manual-exchange session TTL)
// Resource backstop, not a security control: rotation already caps any single
// PIN's exposure at PIN_TTL_MS, so waiting longer is not less safe. This only
// bounds how long an unclaimed transfer keeps publishing rendezvous events and
// holding the file in memory before giving up.
export const PIN_WAIT_TIMEOUT_MS = 30 * 60 * 1000; // Total time the sender keeps rotating/waiting before giving up (30 minutes)
