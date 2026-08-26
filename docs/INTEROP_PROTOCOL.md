# pTransfer Interoperable Protocol

**Interop protocol version: `2`**

This document is the normative wire contract between pTransfer implementations.
The web app is the reference implementation; `ptransfer-cli` is the other
implementation today. The version above is mirrored by
[`src/lib/protocol.ts`](../src/lib/protocol.ts) (`INTEROP_PROTOCOL_VERSION`) and
by `package.metadata.ptransfer-protocol-version` in the CLI's `Cargo.toml`. A
unit test keeps this document and the constant in step.

## Versioning

A single monotonically increasing integer, deliberately **not** the app's npm
version. The app bumps its patch version for any breaking change, and most of
those land in parts of the app no other implementation speaks; a version that
moved on every release would say nothing about interoperability.

- Bump it when **anything specified in this document** changes.
- Leave it alone otherwise, however large the app release.

The version never travels on the wire. There is no negotiation, no capability
exchange, and no compatibility shim: it is a **build-time coordination value**,
not a runtime check. Two implementations agree by declaring the same number, and
the CLI's interoperability test compares the two declarations before spending a
transfer proving it.

Do not rely on a mismatch announcing itself. Some are self-detecting: a changed
domain separator or transcript field list lands the two sides on different keys
or digests, so the PAKE seals refuse to open and the confirmation codes
disagree, and a changed event kind means the receiver simply never finds the
rendezvous. Others are not detected at all. Rotation windows, bucket counts,
guessing budgets, timeouts, size limits, and the NIP-40 expiration formula are
agreed *only* by both sides implementing this document; nothing in the handshake
covers them, and a peer that quietly widened `PIN_ACTIVE_BUCKETS` would weaken
every transfer without a single seal noticing. Matching the declared version is
what rules that out.

### History

| Version | Change |
|---|---|
| `2` | Rendezvous freshness became a bucket test instead of a maximum age (§4.3), so a future-dated `created_at` no longer passes. Senders are unaffected; a v1 receiver is simply more permissive than this document allows. The data channel's ordered/reliable configuration became explicit (§7), which v1 relied on without stating. |
| `1` | Initial specification. |

## Scope

**In scope — an implementation MUST match all of this:**

- PIN Exchange signaling over Nostr: the rendezvous / claim / confirm handshake,
  the PIN and its SPAKE2 password-authenticated key exchange, the key schedule,
  the confirmation code, and the encrypted WebRTC signaling that follows.
- The shared WebRTC data-channel transfer layer: wire encoding, chunk framing,
  completion, and acknowledgement.

**Out of scope — web-only, and no other implementation should implement it
against this document:**

- **Code Exchange** (the hand-carried PT01 offer/answer, its multi-QR chunking,
  its ECDH key agreement, and its answer confirmation tag). It is still
  changing shape — the answer-return path was added and then removed, and the
  answer was recently bound to its offer — so it stays out of the contract
  until it stabilizes. It is described in
  [ARCHITECTURE.md](ARCHITECTURE.md#code-exchange-signaling-srclibcode-signalingts)
  and [CODE_EXCHANGE.md](CODE_EXCHANGE.md), as web-internal documentation.
- The **Nostr file-relay data-path fallback** ([NOSTR_FILE_RELAY.md](NOSTR_FILE_RELAY.md)),
  which only Code Exchange can reach.
- Storage strategy (in-memory vs OPFS scratch), relay health probing and
  caching, UI, timeouts that are purely local resource bounds, and anything
  else that is not observable by the peer.

Where this document and [ARCHITECTURE.md](ARCHITECTURE.md) disagree about the
interoperable subset, this document wins; ARCHITECTURE.md carries the design
rationale and the web-only parts.

## Notation

- `HKDF(ikm, salt, info, len)` is HKDF-SHA256 (extract-then-expand, RFC 5869)
  producing `len` bytes.
- `base64` is standard base64 with padding; `base64url` is unpadded URL-safe
  base64. Hex is lowercase.
- Byte concatenation is `‖`.
- Curve operations are on NIST P-256; points are SEC1 **compressed** (33 bytes)
  unless stated otherwise.
- All timestamps are wall clock. Both peers' clocks must agree within the
  rotation windows described below.

---

## 1. PIN

- **Length**: 12 characters, ungrouped, case-sensitive.
- **Alphabet** (`PIN_CHARSET`, 55 characters — letters and digits with the
  ambiguous `0`, `1`, `I`, `O`, `i`, `l`, `o` removed):

  ```
  ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789
  ```

- **Layout**: characters `0..2` are the public **locator**, characters `3..10`
  are the secret data, and character `11` is the checksum.
- **Checksum**: over the 11 preceding characters,
  `PIN_CHARSET[(Σ index(c_i) · (i+1)) mod 55]` with `i` zero-based, so the
  weight is the one-based position.
- **Generation**: the 11 data characters are drawn from `PIN_CHARSET` by
  rejection sampling on random bytes (`byte < floor(256/55)*55`) to remove
  modulo bias; the checksum is appended.

### 1.1 Rotation buckets

- `PIN_ROTATION_MS` = 120 000 (2 minutes).
- `bucket = floor(now_ms / PIN_ROTATION_MS)`.
- `PIN_ACTIVE_BUCKETS` = 2: a sender honors only PINs minted in its current or
  immediately previous bucket, so a PIN lives roughly 2–4 minutes.
- `PIN_TTL_MS` = `PIN_ROTATION_MS * PIN_ACTIVE_BUCKETS` = 240 000 — the upper
  bound on an active PIN's age. It is a bound, not the test: acceptance is by
  bucket (§4.3), which is exact and also bounds the timestamp from above.
- `PIN_HINT_LOOKBACK_BUCKETS` = `PIN_ACTIVE_BUCKETS - 1` = 1: the receiver
  derives hints for its current and immediately previous bucket.

### 1.2 Rendezvous hint

The public `#h` lookup tag is derived from the **locator alone** — never from
the whole PIN, which would make every published rendezvous an offline oracle
for PIN guesses:

```
hint = hex( HKDF(ikm  = utf8(locator),
                 salt = utf8("ptransfer:pin:v4"),
                 info = utf8("hint:" + bucket),
                 len  = 4) )            # 8 lowercase hex characters
```

The hint carries at most log2(55³) ≈ 17.3 bits, so collisions between unrelated
transfers are expected, not exotic. Receivers MUST treat it as a candidate
filter, never as an identifier.

### 1.3 Transfer id and salt

- `transferId`: 8 random bytes as 16 lowercase hex characters. Stable for the
  whole transfer, across rotations.
- `salt`: 16 random bytes (`SALT_LENGTH`), public, carried in the rendezvous
  event's `s` tag as base64. It is the HKDF salt for every session derivation.

---

## 2. SPAKE2

RFC 9382 SPAKE2 over P-256. The sender is role **A**, the receiver is role **B**.

- Domain separators: `PAKE_CONTEXT` = `ptransfer:spake2-p256:v4`,
  `PAKE_SECRET_SALT` = `ptransfer:spake2-w:v4`.
- `M` and `N` are the RFC 9382 P-256 constants, compressed:
  - `M` = `02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f`
  - `N` = `03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49`

### 2.1 Password scalar

```
wide = HKDF(ikm = utf8(pin), salt = utf8(PAKE_SECRET_SALT), info = utf8("w"), len = 48)
w    = int_be(wide) mod n            # n = P-256 group order; if w == 0, use 1
```

`w` is serialized as 32 big-endian bytes wherever it is hashed. The **whole**
PIN is the input, locator included. There is deliberately **no** key
stretching: stretching only helps against offline guessing, and a balanced PAKE
leaves nothing to grind. Online guessing is metered instead (§4.5).

### 2.2 Elements

Each side picks a fresh random scalar and publishes a blinded element:

- Sender: `pA = x·G + w·M`
- Receiver: `pB = y·G + w·N`

Both are 33-byte compressed points (`PAKE_MESSAGE_LENGTH` = 33).

**Single use (RFC 9382 §7).** Every ephemeral scalar runs exactly one protocol
execution. The receiver picks a fresh `y` per claim it publishes. The sender
picks a fresh `x` per rendezvous element it publishes, and an element is
consumed by the **first claim that targets it**, verified or not — a failed
verification is answered with a replacement rendezvous carrying a fresh `x`,
never by reusing the scalar.

### 2.3 Finishing

The peer element MUST be exactly 33 bytes and a valid curve point. Unblind it
with the *other* constant (`N` for the sender, `M` for the receiver); if the
result is the identity, reject. Then `K = (peer − peerBlind)·ownSecret`,
compressed.

The root key is `SHA-256(TT)` where `TT` is the RFC 9382 transcript with
**8-byte little-endian length prefixes** on every field:

```
TT = len‖utf8(PAKE_CONTEXT + "|" + transferId)
   ‖ len‖utf8(senderPubkey)
   ‖ len‖utf8(receiverPubkey)
   ‖ len‖pA
   ‖ len‖pB
   ‖ len‖K
   ‖ len‖w
```

`senderPubkey` and `receiverPubkey` are the two 64-hex-character Nostr public
keys, hashed as their ASCII text. `pA` is always the sender's element and `pB`
always the receiver's, regardless of which side is computing.

A wrong PIN does **not** fail here; both sides simply land on different roots,
and the mismatch surfaces when a sealed payload fails to open.

---

## 3. Key schedule

Everything is HKDF-SHA256 off the SPAKE2 root, with the public transfer `salt`
as the HKDF salt and a distinct info label:

| Derivation | info label | Output |
|---|---|---|
| Claim seal key | `ptransfer:nostr-session:v4:claim` | AES-256-GCM key |
| Confirm seal key | `ptransfer:nostr-session:v4:confirm` | AES-256-GCM key |
| Signaling key | `ptransfer:nostr-session:v4:signals` | AES-256-GCM key |
| Content key | `ptransfer:nostr-session:v4:content` | AES-256-GCM key |
| Confirmation code | see §5 | 5 bytes |

**AES-GCM framing** for sealed handshake payloads and encrypted signals:

```
nonce(12 bytes, random per message) ‖ ciphertext ‖ tag(16 bytes)
```

with no additional authenticated data. (The data-channel chunk format in §7 is
different and does use AAD.)

---

## 4. Nostr signaling

### 4.1 Event kinds

| Kind | Class | Use |
|---|---|---|
| `4243` | regular (relays retain it) | Rendezvous |
| `24243` | ephemeral | Claim, confirm, and WebRTC signal |

The rendezvous is a **regular** kind on purpose: a receiver that connects after
publication must still be able to query it, which an ephemeral kind would not
allow. Its lifetime is bounded by a NIP-40 `expiration` tag instead.

### 4.2 Default relays

```
wss://relay.damus.io
wss://nos.lol
wss://relay.primal.net
wss://nostr.rocks
wss://relay.nostr.pub
wss://relay.snort.social
```

### 4.3 Rendezvous event (sender → everyone)

Kind `4243`, republished every rotation until a claim verifies, and republished
immediately when a claim consumes an element without verifying.

Tags, in order:

| Tag | Value |
|---|---|
| `h` | the bucket-scoped hint (§1.2) |
| `s` | base64 of the 16-byte salt |
| `t` | `transferId` |
| `type` | `rendezvous` |
| `expiration` | `floor((pinBucket + PIN_ACTIVE_BUCKETS) * PIN_ROTATION_MS / 1000)` |

Content is **plaintext** JSON — with a PAKE nothing in it may be PIN-testable,
and encrypting it under a PIN-derived key would put the offline guessing target
back:

```json
{
  "type": "rendezvous",
  "transferId": "<16 hex>",
  "senderPubkey": "<64 hex, MUST equal the event author>",
  "pakeMessage": "<base64 of pA, 33 bytes>",
  "nonce": "<base64 of 16 random bytes, fresh per rotation>",
  "relays": ["wss://…"]
}
```

`relays` is optional. **File metadata is deliberately absent** — it travels
sealed inside the confirm.

Receivers MUST reject a rendezvous whose payload does not name the event's own
author, or whose element is not a valid non-identity point.

Receivers MUST also reject one whose `created_at` did not fall in a bucket the
sender still honors:

```
floor(created_at * 1000 / PIN_ROTATION_MS) ∈
    { bucket(now) - PIN_HINT_LOOKBACK_BUCKETS, …, bucket(now) }
```

This is a **bucket test, not an age test**, and the difference is the point. An
age test (`now - created_at <= PIN_TTL_MS`) is unbounded above: an event stamped
a year from now has a negative age, so it passes forever, and because candidates
are ordered newest first it also sorts ahead of the genuine sender and consumes
the `MAX_CLAIM_CANDIDATES` budget — a retained kind-`4243` event, so it keeps
doing so for as long as the relay serves it. Anchoring to the bucket bounds
`created_at` from both sides and costs an honest sender nothing: it stamps
`created_at` and derives the `#h` tag from the same clock reading, so a clock
skewed far enough to fail this test has already skewed the hint out of the set
the receiver queries. A rendezvous that lands outside the window is not a
rotated PIN — implementations SHOULD NOT report a future-dated one as expired.

Candidates are considered newest first, at most one per `transferId`, and at
most `MAX_CLAIM_CANDIDATES` (8) are claimed. The `#h` query uses `limit: 50` to
leave headroom for hint collisions. Neither this rule nor the candidate cap
keeps a flood of forged events from filling that page; see *Availability Is a
Non-Goal* in `ARCHITECTURE.md`.

### 4.4 Rendezvous transcript hash

Bound into the sealed claim and confirm, and into the confirmation code, so the
two peers agree on the *whole* published record — not only the fields the
SPAKE2 transcript already covers.

```
label     = "ptransfer:nostr-rendezvous-transcript:v4"
canonical = JSON.stringify([ label, type, transferId, senderPubkey,
                             pakeMessage, nonce, relays ?? [], hex(salt) ])
hash      = hex(SHA-256(utf8(canonical)))
```

A JSON **array** rather than an object, so element order is fixed rather than
dependent on key ordering, and JSON string escaping keeps a field value from
forging a delimiter into its neighbor. `relays` canonicalizes to `[]` when
absent.

### 4.5 Claim (receiver → sender)

Kind `24243`. Tags, in order: `p` = sender pubkey, `t` = `transferId`,
`type` = `claim`.

Content is a JSON envelope:

```json
{ "sealed": "<base64>", "pake": "<base64 of pB>", "target": "<transcript hash hex>" }
```

`pake` rides in plaintext because the sender must finish its own side of the
PAKE before any key exists. `target` routes the claim to the single element it
spends; it carries **no authority** — the sealed body echoes the same hash, and
that echo is what is verified.

The sealed body, under the claim key:

```json
{
  "type": "claim",
  "transferId": "…",
  "senderNonce": "<echo of the rendezvous nonce>",
  "receiverNonce": "<base64 of 16 fresh random bytes>",
  "senderPubkey": "…",
  "receiverPubkey": "<MUST equal the claim event author>",
  "transcriptHash": "…"
}
```

**Sender verification.** Route by `target` to the one retained generation whose
*current* element it names, and only if that generation's bucket is still
active and its budget remains; a claim naming a spent, expired, or foreign
target costs nothing and is dropped. Then: consume the element, spend one unit
of `CLAIM_VERIFY_LIMIT` (100 per generation — this is the online-guessing
meter), finish the PAKE against `pB`, and try the seal. A body that opens *and*
matches the publication's nonce, the transfer id, the sender's own pubkey, the
claim event's author, and the publication's transcript hash locks the transfer.
Re-check the bucket after the asynchronous verification so a boundary crossing
cannot admit an expired claim. **The first verified claim wins**: rotation and
rendezvous publishing stop, retained PAKE secrets are wiped, and every other
claim is ignored.

A claim that fails verification MUST NOT be fatal (transfer tags are public, so
failing hard would let any observer kill transfers) and MUST trigger a
replacement rendezvous publish for that generation: fresh `x`, element, and
nonce; same transfer id, hint, bucket, and salt.

Receivers publish at most `MAX_CLAIM_ATTEMPTS` (16) claims per receive attempt,
counting initial candidates and re-claims of replacement elements.

### 4.6 Confirm (sender → receiver)

Kind `24243`, tags `p` = receiver pubkey, `t` = `transferId`,
`type` = `confirm`. Content is the same envelope shape with only `sealed` set.

Published **immediately** on claim verification — it is not gated on the
confirmation code. Sealed under the confirm key:

```json
{
  "type": "confirm",
  "transferId": "…",
  "senderNonce": "…",
  "receiverNonce": "…",
  "senderPubkey": "<MUST equal the confirm event author>",
  "receiverPubkey": "…",
  "transcriptHash": "…",
  "metadata": { … }
}
```

The receiver MUST verify every echoed field before acting on the metadata, and
MUST reject metadata that is not shaped as §4.7 requires.

### 4.7 Transfer metadata

```json
{
  "contentType": "file",
  "fileName": "<non-empty string>",
  "fileSize": <non-negative number>,
  "contentEncoding": "deflate-raw" | "identity",
  "mimeType": "<string>"
}
```

- `contentType` is `"file"`; no other value is defined.
- `fileSize` is the **input** size — a progress hint only. It is never the wire
  length, and never a bound on the payload; the wire byte count is
  authenticated in band by `DONE` (§7).
- `contentEncoding` is how the payload bytes travel (§6). A receiver MUST reject
  any value other than the two above.

Metadata digest, bound into the confirmation code:

```
label     = "ptransfer:nostr-metadata-transcript:v2"
canonical = JSON.stringify([ label, contentType, fileName, fileSize,
                             contentEncoding, mimeType ])
hash      = hex(SHA-256(utf8(canonical)))
```

### 4.8 WebRTC signals

Kind `24243`, tags in order `t` = `transferId`, `p` = **sender** pubkey (both
directions), `type` = `signal`. Content is base64 of the AES-GCM sealing (§3,
signals key) of:

```json
{ "type": "signal", "signal": { … offer | answer | candidate … } }
```

Subscription filters:

- Sender waiting for the answer: kind `24243`, `#t` = transfer id,
  `#p` = its own pubkey, `authors` = the locked receiver.
- Receiver waiting for the offer: kind `24243`, `#t` = transfer id,
  `authors` = the sender.

Offer and answer bundles are republished while the connection is pending, so a
relay miss does not strand the session.

---

## 5. Confirmation code

The anti-front-running control. A PIN can be shoulder-surfed, and whoever saw
it can win the claim race; the code moves the final go/no-go onto a channel the
attacker does not control.

```
info = "ptransfer:nostr-session:v4:confirmation"
     + "|" + transferId
     + "|" + senderNonce
     + "|" + receiverNonce
     + "|" + transcriptHash
     + "|" + metadataHash
bits = HKDF(root, salt, utf8(info), 5)          # 40 bits
code = crockfordBase32(bits)                    # 8 characters
```

`transferId` and both hashes are hex and both nonces are fixed-length base64, so
`|` cannot occur inside a field and the join is unambiguous.

- The **receiver** derives and displays it once the confirm verifies.
- The **sender** derives the same value and publishes **no WebRTC signal and no
  file byte** until its operator enters a matching code. Comparison normalizes
  Crockford Base32 (`I`/`L` → `1`, `O` → `0`, case-insensitive, hyphens
  ignored). A mismatch is retryable — a typo must not kill a transfer — and
  never opens the gate.

---

## 6. Wire encoding

The compression rule is **flow-based, never content-sniffed**:

| Payload | `contentEncoding` |
|---|---|
| A single file | `deflate-raw` |
| A generated ZIP (multiple files or a folder) | `identity` |

A single file is deflated on the fly with **raw DEFLATE** (RFC 1951 — no zlib
or gzip wrapper) and inflated by the receiver. A ZIP is already compressed
entry by entry and is never recompressed. Either way the final wire length is
unknown during signaling, which is why `fileSize` is only a hint and `DONE`
carries the authoritative count.

Whether a ZIP's entries are stored or deflated is an implementation choice and
not part of this contract; only the outer `contentEncoding` is.

Receivers MUST bound inflate **output** at `MAX_MESSAGE_SIZE` and abort beyond
it, as a decompression-bomb guard.

---

## 7. Data-channel transfer

Once the WebRTC data channel is open, both peers hold the `content` key and run
this protocol. It is the same protocol for every signaling method.

Whichever peer creates the channel MUST create it **ordered and reliable** —
the WebRTC default, i.e. `ordered: true` with neither `maxRetransmits` nor
`maxPacketLifeTime` set. This is stated rather than assumed because §7.3's
receive discipline has no way to recover otherwise: an unordered channel still
delivers every message, but SCTP hands each one up as soon as it reassembles,
so a single retransmit lets a later chunk overtake an earlier one and the peer
rejects the index. Nothing on the wire announces the setting, and a loopback or
lossless path never reveals it, so an implementation whose WebRTC binding
defaults differently can pass every local test and corrupt every real
transfer.

### 7.1 Chunk framing

The payload — in its wire encoding (§6) — is split into `ENCRYPTION_CHUNK_SIZE`
= 128 KiB pieces, and each is sent as one **binary** data-channel message:

```
[2 bytes: chunk index, big-endian][12 bytes: nonce][ciphertext][16 bytes: tag]
```

AES-256-GCM under the content key. **The 2-byte index prefix is also passed as
additional authenticated data**, so a receiver rejects a chunk whose index was
altered or whose ciphertext was swapped with another chunk's.

Indices start at 0 and increase by one. The 2-byte field caps a transfer at
65 536 chunks (`MAX_CHUNKS`).

Senders apply WebRTC backpressure (the reference implementation drains at a
1 MiB `bufferedAmountLowThreshold`).

### 7.2 Completion

After the last chunk the sender sends one **text** message:

```
DONE:<totalChunks>:<totalBytes>
```

`totalBytes` is the **wire** byte count (post-encoding, pre-encryption). Both
values are decimal, non-empty, no sign, no leading `+`.

The receiver MUST verify that the chunk count matches what it received, that
indices arrived exactly once in data-channel order, and that the decrypted wire
byte count matches — then, and only then, reply with the text message:

```
ACK
```

The sender waits `ACK_TIMEOUT_MS` = 30 s for it; a timeout is a transfer
failure.

### 7.3 Receive discipline

Receivers **append in reliable data-channel order**. There is no positional or
out-of-order write path: no wire payload has a length known up front, so an
index cannot be turned into an offset. A receiver MUST reject a chunk whose
index is not the next expected one, a duplicate index, a short chunk before the
final one, a malformed length, and a transfer that exceeds `MAX_MESSAGE_SIZE`.

There is **no whole-file checksum and no manifest**. Integrity rests entirely
on per-chunk AES-GCM authentication with the authenticated index, plus the
completeness checks above.

### 7.4 Stall watchdog

`STALL_TIMEOUT_MS` = 60 s, an idle window rather than an overall deadline. The
sender applies it to each chunk hand-off; the receiver arms it when the channel
opens and resets it on every incoming message, `DONE` included. A steadily
progressing transfer of any size never trips it.

---

## 8. Constants

| Name | Value |
|---|---|
| `PIN_LENGTH` | 12 |
| `PIN_LOCATOR_LENGTH` | 3 |
| `PIN_CHARSET` length | 55 |
| `PIN_HINT_LENGTH` | 8 hex characters |
| `PIN_ROTATION_MS` | 120 000 |
| `PIN_ACTIVE_BUCKETS` | 2 |
| `PIN_TTL_MS` | 240 000 (bound only — see §1.1) |
| `PIN_HINT_LOOKBACK_BUCKETS` | 1 |
| `CLAIM_VERIFY_LIMIT` | 100 per PIN generation |
| `MAX_CLAIM_CANDIDATES` | 8 |
| `MAX_CLAIM_ATTEMPTS` | 16 |
| `CONFIRMATION_CODE_BYTES` / `_LENGTH` | 5 bytes / 8 characters |
| `SALT_LENGTH` | 16 bytes |
| Handshake nonce | 16 bytes |
| `PAKE_MESSAGE_LENGTH` | 33 bytes |
| `AES_KEY_LENGTH` | 256 bits |
| `AES_NONCE_LENGTH` | 12 bytes |
| `AES_TAG_LENGTH` | 16 bytes |
| `ENCRYPTION_CHUNK_SIZE` | 128 KiB |
| `MAX_CHUNKS` | 65 536 |
| `MAX_MESSAGE_SIZE` | 2 GiB |

Peer-visible timeouts:

| Timeout | Value |
|---|---|
| Receiver wait for the confirm | 60 s |
| Sender confirmation-code entry | 150 s |
| Receiver wait for the sender's first signal | 180 s |
| WebRTC connection | 30 s |
| ICE gathering | 5 s |
| Signal bundle retry interval | 5 s |
| Data-channel `ACK` | 30 s |
| Transfer stall (idle) | 60 s |
| Sender rotation/wait backstop | 30 min |

---

## 9. Test vectors

Frozen digests for the two canonicalizations in §4.4 and §4.7. An
implementation that reproduces both has its field order, version labels, JSON
escaping, and encodings right — which is most of what silently diverges.

### 9.1 Rendezvous transcript hash

Input — salt is 32 bytes of `0x07`:

```json
{
  "type": "rendezvous",
  "transferId": "a1b2c3d4e5f60718",
  "senderPubkey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "pakeMessage": "ApAkEeLeMeNtBase64==",
  "nonce": "c2VuZGVyLW5vbmNlLTAwMDAwMDA=",
  "relays": ["wss://relay.one", "wss://relay.two"]
}
```

```
edf3c4ce9b70adf0cb6e316e247f2f840e18af094d20466dfd55c00e694be675
```

### 9.2 Transfer metadata hash

Input:

```json
{
  "contentType": "file",
  "fileName": "quarterly-report.pdf",
  "fileSize": 1048576,
  "contentEncoding": "deflate-raw",
  "mimeType": "application/pdf"
}
```

```
d71c5d4c12479dfb7e1e4f7c9fd169cddd73206e8c369d49a98f7b726a025f84
```

Both vectors are pinned in
[`src/lib/nostr/transcript.test.ts`](../src/lib/nostr/transcript.test.ts) on the
web side. Changing either digest is a protocol bump, never an accident.

---

## 10. Reference implementation

| Section | Web source |
|---|---|
| PIN, hint, transfer id | [`src/lib/crypto/pin.ts`](../src/lib/crypto/pin.ts), [`constants.ts`](../src/lib/crypto/constants.ts) |
| SPAKE2 | [`src/lib/crypto/spake2.ts`](../src/lib/crypto/spake2.ts) |
| Key schedule, confirmation code | [`src/lib/crypto/kdf.ts`](../src/lib/crypto/kdf.ts) |
| AES-GCM framing | [`src/lib/crypto/aes-gcm.ts`](../src/lib/crypto/aes-gcm.ts) |
| Events, tags, filters | [`src/lib/nostr/events.ts`](../src/lib/nostr/events.ts), [`types.ts`](../src/lib/nostr/types.ts) |
| Transcript hashes | [`src/lib/nostr/transcript.ts`](../src/lib/nostr/transcript.ts) |
| Handshake choreography | [`src/hooks/use-pin-send.ts`](../src/hooks/use-pin-send.ts), [`use-pin-receive.ts`](../src/hooks/use-pin-receive.ts) |
| Wire encoding | [`src/lib/transfer-source.ts`](../src/lib/transfer-source.ts) |
| Data-channel protocol | [`src/lib/p2p-transfer.ts`](../src/lib/p2p-transfer.ts) |

Design rationale for all of the above — why a PAKE, why the PIN is split, what
the confirmation code does and does not cover, the threat model — is in
[ARCHITECTURE.md](ARCHITECTURE.md).
