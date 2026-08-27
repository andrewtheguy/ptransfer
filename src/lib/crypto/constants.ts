// PIN generation
export const PIN_LENGTH = 12;
export const PIN_CHECKSUM_LENGTH = 1; // Last character is checksum

// The length of the PIN minted when the sender turns on anonymous signaling
// (docs/ANONYMOUS_SIGNALING.md). The length is the signal: the two modes reach
// disjoint relay pools, so the receiver has to know which one to connect to
// before it can look for anything, and the PIN is the only thing it is handed.
// Encoding the mode in a length rather than a prefix character keeps every
// other property of a PIN intact — same alphabet, same weighted checksum, same
// three-character locator — so nothing downstream has to special-case it.
//
// The four extra characters are secret data, not locator, so the locator-keyed
// hint derivation is untouched and the online-guessing space grows from
// PIN_CHARSET.length ** 8 to ** 12 (about 2^69.5). That is a side effect of the
// length, not its purpose; the guessing bound that matters is still
// CLAIM_VERIFY_LIMIT, which is unchanged.
export const ANONYMOUS_PIN_LENGTH = 16;

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
// the end of its second bucket, which is what both sides actually test against
// (isPinBucketActive / isRendezvousFresh) — PIN_TTL_MS is only the bound that
// falls out of it.
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

// Code Exchange answer confirmation tag: the key-confirmation value the
// receiver folds into its answer code (see deriveAnswerConfirmation). It is
// derived from the ECDH shared secret and bound to two digests — the exact
// offer container the receiver acted on, and the answer's own fields — so the
// sender can check that the answer in its hand was produced by a peer that
// read *this* offer, completed the same key agreement, and sent *this* answer.
//
// This is machine-checked, never read by a human: nothing is displayed and
// nothing is typed. It is not the PIN Exchange confirmation code and does not
// do that job — the offer is still the only secret gating a Code Exchange
// transfer, so whoever captures the offer can still produce a valid tag. What
// it closes is the gap below it: an answer from another transfer, a replayed
// answer, and an answer whose SDP or ICE candidates were altered on the way
// back are now rejected outright instead of silently derailing into a dead
// connection or a garbage decrypt.
//
// 16 bytes = 128 bits, base64 in the payload (24 characters). Forging one
// without the shared secret is a 2^-128 shot, and the width costs a couple of
// dozen bytes in a single answer QR.
export const ANSWER_CONFIRMATION_BYTES = 16;

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

// Application cap on a transfer that does not run over a direct WebRTC data
// channel: the Nostr file relay and the Tor onion transport. Two independent
// reasons put it at exactly the memory-sink threshold, which is why it is
// derived from it rather than spelled again:
//
//   - Both paths push bytes through third parties at a fraction of a data
//     channel's speed, and neither can resume, so a transfer that dies two
//     thirds of the way through starts over. MAX_MESSAGE_SIZE stops meaning
//     anything on them long before it is reached.
//   - A payload this size or smaller is received entirely in memory, so these
//     paths never depend on OPFS `createWritable` — which some engines shipped
//     late (Safari/iOS only in 26) and which a receiver may simply not have.
//     Above the threshold a receive can fail for a reason the sender has no
//     way to see coming.
//
// It is one constant rather than one per transport because a receiver enforces
// the sender's ceiling as its own: two numbers that drifted apart would show up
// as a transfer refused mid-handshake for no reason a user could act on.
export const SLOW_TRANSPORT_MAX_BYTES = MEMORY_SINK_MAX_BYTES;

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
// room for that (see the rendezvous lookup in use-pin-receive.ts).
export const PIN_HINT_LENGTH = 8; // hex characters

// Transfer timeouts
export const TRANSFER_EXPIRATION_MS = 60 * 60 * 1000; // 1 hour (Code Exchange session TTL)
// Resource backstop, not a security control: rotation already caps any single
// PIN's exposure at PIN_TTL_MS, so waiting longer is not less safe. This only
// bounds how long an unclaimed transfer keeps publishing rendezvous events and
// holding the file in memory before giving up.
export const PIN_WAIT_TIMEOUT_MS = 30 * 60 * 1000; // Total time the sender keeps rotating/waiting before giving up (30 minutes)
