// PIN generation
export const PIN_LENGTH = 12;
export const PIN_CHECKSUM_LENGTH = 1; // Last character is checksum

// The leading PIN_LOCATOR_LENGTH characters are the PIN's *locator* segment.
// They are the only input to the published rendezvous hint, which makes them
// public by construction: a hint has at most PIN_CHARSET.length ** 3 = 166,375
// preimages per rotation bucket, so anyone can enumerate locator -> hint and
// read the locator straight off a relay event.
//
// Splitting the PIN this way is deliberate. The remaining data characters are
// the only entropy the SPAKE2 handshake rests on, so the published tag can
// never be used to chip away at them; conversely the locator alone opens
// nothing. Effective PIN strength is PIN_CHARSET.length ** 8 (about 2^46.3),
// not ** 11 (2^63.6).
//
// 2^46.3 would fall to an offline attack, and that is the point of the SPAKE2
// handshake: there is no offline attack. Every published value — the blinded
// SPAKE2 elements, the sealed claim/confirm payloads — is useless for
// verifying a PIN guess without a live protocol run, so the only way to test
// a guess is to publish a claim and have the sender verify it online. The
// sender caps those verifications (CLAIM_VERIFY_LIMIT per generation), so an
// attacker gets at most a few hundred guesses against a space of ~8.4e13
// during the 2-4 minutes a PIN lives. The confirmation code (see
// CONFIRMATION_CODE_LENGTH) remains the control that a PIN read off the
// sender's screen cannot defeat at all.
export const PIN_LOCATOR_LENGTH = 3;

// Case-sensitive PIN alphabet: letters and digits excluding ambiguous
// characters (0, 1, I, O, i, l, o). 55 characters, no symbols, so the PIN
// types cleanly on any mobile keyboard and survives being read aloud.
export const PIN_CHARSET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

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

// HKDF salt for the locator-keyed rendezvous hint derivation
// ('hint:<bucket>'). Public constant for domain separation only: the hint is
// keyed by the public locator segment and never by any PIN secret.
export const PIN_HINT_HKDF_SALT = 'ptransfer:pin:v4';

// How many SPAKE2 claim verifications the sender will run per PIN generation.
// With a balanced PAKE the only way to test a PIN guess is to publish a claim
// and have the sender try to verify it, so this cap is the online guessing
// bound: at most CLAIM_VERIFY_LIMIT stretched-by-nothing guesses per
// generation against a 55^8 ~= 8.4e13 space. Every element is single-use, so
// each failed verification also costs the sender one replacement rendezvous
// publish; this budget therefore bounds the republish churn too. Exhausting
// the budget stalls that generation's transfer (a nuisance, not a compromise —
// see "Availability Is a Non-Goal" in docs/ARCHITECTURE.md); rotation mints a
// fresh budget with the next PIN.
export const CLAIM_VERIFY_LIMIT = 100;

// How many rendezvous candidates the receiver will claim per attempt. The
// hint carries only ~17.3 bits, so unrelated transfers can collide on it, and
// with a plaintext rendezvous the receiver cannot tell which candidate is its
// sender until a confirm verifies — so it claims several. Each claim hands
// whoever published that candidate one online guess at our PIN (that is
// inherent to any PAKE), so the cap also bounds what a flood of forged
// rendezvous events can extract.
export const MAX_CLAIM_CANDIDATES = 8;

// Total claims one receive attempt may publish, initial candidates plus
// re-claims against replacement rendezvous events (the sender's elements are
// single-use, so a claim that lost the race to a spent element must be redone
// against the replacement). The cap is what bounds the online guesses a
// claimed candidate's author can milk by rotating replacement elements at us:
// MAX_CLAIM_ATTEMPTS guesses against 2^46.3, spread over however many
// publishers we claimed from.
export const MAX_CLAIM_ATTEMPTS = 16;

// Confirmation code: the short authentication string both peers derive from
// the SPAKE2 shared secret once a claim is on the table. The receiver
// displays it; the sender's operator types what the receiver reads out, and
// only a match releases the WebRTC offer and any file bytes.
//
// This is what stops a front-runner. Whoever wins the claim race, the sender
// never sends file data until it has been handed a code that only the peer
// holding the matching SPAKE2 session can produce — so a PIN that leaked off
// the sender's screen buys an attacker a locked-out session, not a file.
// Because it is keyed by the shared secret it also proves no relay tampered
// with either side's key-exchange element.
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
// 128 KiB chunks, each encrypted with a unique nonce.
// The WebRTC data channel has a ~256 KiB message limit, so 128 KiB plus
// encryption overhead stays safe.
export const ENCRYPTION_CHUNK_SIZE = 128 * 1024; // 128 KiB

// Application cap on selected plaintext input (one file, or the total files
// used to generate a ZIP). Every P2P stage streams: the sender encrypts lazy
// 128 KiB wire chunks and the receiver writes plaintext to adaptive scratch
// storage. The cap stays below the 2-byte chunk-index capacity; payloads over
// MEMORY_SINK_MAX_BYTES require OPFS on the receiver.
export const MAX_MESSAGE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GiB

// Payloads at or below this size are buffered in memory during transfer;
// larger payloads require OPFS scratch storage.
export const MEMORY_SINK_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB

// PIN hint length.
// 8 hex chars of output, but the hint is derived from the locator segment
// alone, so it carries at most log2(PIN_CHARSET.length ** PIN_LOCATOR_LENGTH)
// ~= 17.3 bits and is enumerable by design — it is a public candidate-filtering
// tag, nothing more. The tag width stays at 8 characters because widening it
// costs nothing; the locator caps the real entropy either way.
//
// The practical consequence is collisions: unrelated transfers sharing a bucket
// collide on `#h` at roughly 1 in 166,375 per pair rather than 1 in 2^32, so a
// receiver must expect unrelated candidates. It cannot disambiguate them
// locally (the rendezvous is plaintext and the PAKE only settles who knew the
// PIN at confirm time), so it claims up to MAX_CLAIM_CANDIDATES of them and
// lets the handshake pick the real one. Query limits on `#h` have to leave
// room for that (see the rendezvous lookup in use-nostr-receive.ts).
export const PIN_HINT_LENGTH = 8; // hex characters

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000; // 1 hour (manual-exchange session TTL)
// Resource backstop, not a security control: rotation already caps any single
// PIN's exposure at PIN_TTL_MS, so waiting longer is not less safe. This only
// bounds how long an unclaimed transfer keeps publishing rendezvous events and
// holding the file in memory before giving up.
export const PIN_WAIT_TIMEOUT_MS = 30 * 60 * 1000; // Total time the sender keeps rotating/waiting before giving up (30 minutes)
