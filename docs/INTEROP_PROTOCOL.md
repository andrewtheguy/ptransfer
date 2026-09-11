# pTransfer Protocol: PIN Exchange and the Transfer Layer

This document specifies the wire protocol for PIN Exchange and the transfer
layer every mode shares once a transport is open. The browser tab runs it
from `src/lib`. The CLI in `cli/` runs the same transfer layer under its Tor
commands, and PIN Exchange once that lands ([ROADMAP.md](ROADMAP.md)), so
there is one implementation and this is its specification: where the code and
this document disagree, this document is what the code is meant to do.

The protocol version is `PROTOCOL_VERSION` in `src/lib/protocol-version.ts`,
separate from the app's release version. Two peers on the same protocol version
interoperate whatever releases they run; two on different ones are not
guaranteed to. It is bumped for any change this document or another protocol
document specifies, and it is not sent, so no peer checks it. Some
divergences announce themselves: a changed domain separator or transcript
field list lands the two sides on different keys or digests, so the PAKE seals
refuse to open and the confirmation codes disagree, and a changed event kind
means the receiver simply never finds the rendezvous. Others — rotation
windows, bucket counts, guessing budgets, timeouts, size limits, the NIP-40
expiration formula — are agreed only by both sides running the same protocol
version, which is why the values here are constants and not negotiated.

## Scope

**In scope — what this document fixes:**

- PIN Exchange signaling over Nostr: the rendezvous / claim / confirm handshake,
  the PIN and its SPAKE2 password-authenticated key exchange, the key schedule,
  the confirmation code, and the sealed carriage of a Code Exchange offer and
  answer that follows it (§4.8).
- The shared transfer layer that runs once a transport is open: wire
  encoding, chunk framing, flow control, completion, and abort (§6–§7).

**Outside this document.** Some of it is host-specific and observable by no
peer; the rest are modes specified by their own documents:

- **Code Exchange** (the PT01 offer/answer, its ECDH key agreement, its answer
  confirmation tag, and its anonymous Tor fallback), a mode with its own
  specification in [CODE_EXCHANGE_PROTOCOL.md](CODE_EXCHANGE_PROTOCOL.md).
  PIN Exchange carries its two codes (§4.8), so a PIN Exchange session runs
  that contract from the offer on — key schedule, direct attempt, and
  fallbacks — and it governs all of it. What is fixed here is only how the
  codes travel over the PIN session, and what a PIN receiver checks about an
  offer on top of what that contract checks. Its direct transfer uses §7 of
  this document, which is governed here; its multi-QR carriage is browser-only
  and is described in
  [ARCHITECTURE.md](ARCHITECTURE.md#code-exchange-signaling-srclibcode-signalingts).
- The **Nostr file-relay data-path fallback** ([NOSTR_FILE_RELAY.md](NOSTR_FILE_RELAY.md)),
  the clearnet fallback a Code Exchange offer's `relays` field selects —
  whether a person carried that offer or a PIN session did. It is governed by
  its own document rather than by this one.
- **Anonymous signaling** ([ANONYMOUS_SIGNALING.md](ANONYMOUS_SIGNALING.md)):
  an experimental PIN Exchange option that carries this same handshake to a
  disjoint pool of
  onion-service relays through a Tor client, and announces itself by minting a
  longer PIN. The handshake on the wire is identical; the transport and the PIN
  length are not. It stays outside this document while the relay pool is
  unmonitored and the option is experimental, and it is specified in its own
  document, the way the Tor onion transfer mode is. Its offers ask for Code
  Exchange's Tor fallback rather than the clearnet one (§4.8). Under this
  document alone a PIN that is not exactly `PIN_LENGTH` characters (§1) is
  rejected rather than attempted — the relay pool such a PIN names is not in
  this document, so a transfer could not succeed anyway.
- The **Tor onion transfer mode**, a transport specified separately by
  [TOR_TRANSPORT.md](TOR_TRANSPORT.md).
- Storage strategy (in-memory vs OPFS scratch), relay health probing and
  caching, UI, timeouts that are purely local resource bounds, and anything
  else that is not observable by the peer.

Where this document and [ARCHITECTURE.md](ARCHITECTURE.md) disagree about
anything in scope here, this document wins; ARCHITECTURE.md carries the design
rationale and the browser-only parts.

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

- **Length**: exactly 12 characters, ungrouped, case-sensitive. A PIN of any
  other length MUST be rejected. (A 16-character variant exists, minted by the
  anonymous-signaling option; it selects a relay pool outside this document
  and is accepted under [ANONYMOUS_SIGNALING.md](ANONYMOUS_SIGNALING.md), never
  this one.)
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
| Confirmation code | see §5 | 5 bytes |

There is no PAKE content key. The file is encrypted under the content key of
the Code Exchange session the handshake carries (§4.8) — the ECDH derivation
of [CODE_EXCHANGE_PROTOCOL.md §3](CODE_EXCHANGE_PROTOCOL.md#3-key-schedule) —
and so is everything either fallback derives. The PAKE's part is to
authenticate the two codes that agreement rides in.

**AES-GCM framing** for sealed handshake payloads and carried codes:

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
| `24243` | ephemeral | Claim, confirm, and carried code |

The rendezvous is a **regular** kind on purpose: a receiver that connects after
publication must still be able to query it, which an ephemeral kind would not
allow. Its lifetime is bounded by a NIP-40 `expiration` tag instead.

### 4.2 Default relays

```
wss://relay.damus.io
wss://nos.lol
wss://relay.primal.net
wss://nostr.rocks
wss://relay.nostr.com
wss://nostr.oxtr.dev
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

`relays` is optional. **File metadata is absent**; it travels sealed inside the
confirm rather than appearing in the plaintext rendezvous.

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
rotated PIN — a receiver SHOULD NOT report a future-dated one as expired.

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
  authenticated in band by `end` (§7.4).
- `contentEncoding` is how the payload bytes travel (§6). A receiver MUST reject
  any value other than the two above.

Metadata digest, bound into the confirmation code:

```
label     = "ptransfer:nostr-metadata-transcript:v2"
canonical = JSON.stringify([ label, contentType, fileName, fileSize,
                             contentEncoding, mimeType ])
hash      = hex(SHA-256(utf8(canonical)))
```

### 4.8 Carried codes

Once the confirmation code matches (§5), the two peers run a Code Exchange
session ([CODE_EXCHANGE_PROTOCOL.md](CODE_EXCHANGE_PROTOCOL.md)): the sender
makes an offer, the receiver answers it, and everything from there — the ECDH
key schedule, the answer confirmation tag, the direct WebRTC attempt, and the
fallback the offer names — is that contract's. What this section fixes is how
the two codes travel: sealed under the session's signals key, rather than
handed over by a person.

Kind `24243`, tags in order `t` = `transferId`, `p` = **sender** pubkey (both
directions), `type` = `signal`. Content is base64 of the AES-GCM sealing (§3,
signals key) of:

```json
{ "type": "offer" | "answer", "code": "<base64 of the PT01 container>" }
```

The container rides byte for byte: the answer's confirmation tag is bound to a
digest of the offer container's bytes, so both sides must hash the same bytes.

Subscription filters:

- Sender waiting for the answer: kind `24243`, `#t` = transfer id,
  `#p` = its own pubkey, `authors` = the locked receiver.
- Receiver waiting for the offer: kind `24243`, `#t` = transfer id,
  `authors` = the sender.

The exchange:

1. The sender publishes **no offer** until its operator has entered the
   matching confirmation code. It then publishes its offer, and republishes it
   every 5 s until an answer arrives, so a relay miss does not strand the
   session.
2. The receiver acts on the **first** offer that opens under the signals key
   and ignores any different one after it. It answers that offer, and answers
   again each time the same offer is repeated — the sender has not seen the
   answer yet.
3. The sender takes the first answer that opens under the signals key and
   checks its confirmation tag exactly as Code Exchange does, refusing a
   mismatch before it acts on anything in it.

On top of what Code Exchange itself checks, a PIN receiver MUST refuse an
offer that:

- describes a different file than the confirm delivered — `fileName`,
  `fileSize`, `contentEncoding`, and `mimeType` must all equal the confirm's
  metadata (§4.7), which is what the confirmation code attests to; or
- asks for a fallback on the other side of the PIN's privacy line. A standard
  PIN's offer names clearnet `relays` or no fallback; an anonymous PIN's
  ([ANONYMOUS_SIGNALING.md](ANONYMOUS_SIGNALING.md)) carries `anon: true` or
  no fallback. A sender whose selection is over the Tor fallback's cap offers
  none rather than the clearnet one.

The seal is what authenticates the codes here, where a person's hand does in
Code Exchange: only the two ends of the locked PAKE session hold the signals
key, and the sender seals nothing under it before the human gate opens.

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
- The **sender** derives the same value and publishes **no offer and no file
  byte** until its operator enters a matching code. Comparison normalizes
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
unknown during signaling, which is why `fileSize` is only a hint and `end`
carries the authoritative count.

Whether a ZIP's entries are stored or deflated is the archiver's choice and
not part of this document; only the outer `contentEncoding` is.

Receivers MUST bound inflate **output** at `MAX_MESSAGE_SIZE` and abort beyond
it, as a decompression-bomb guard.

---

## 7. Transfer

Once a transport is open, both peers hold the content key and run this
protocol. It is the same protocol for every mode: over a WebRTC data channel
for PIN Exchange and Code Exchange, whose content key is the Code Exchange
session's (§3), and over a framed onion stream for the Tor transport of
[TOR_TRANSPORT.md](TOR_TRANSPORT.md), whose handshake supplies its own.

The transport is a **reliable, ordered** message link that keeps binary and
text messages apart. It may carry other traffic in both directions beside the
transfer — PIN Exchange's code carriage does — but the transfer itself uses
one direction. Whichever peer creates a data channel
MUST create it **ordered and reliable** — the WebRTC default, i.e.
`ordered: true` with neither `maxRetransmits` nor `maxPacketLifeTime` set. This
is stated rather than assumed because §7.5's receive discipline has no way to
recover otherwise: an unordered channel still delivers every message, but SCTP
hands each one up as soon as it reassembles, so a single retransmit lets a
later chunk overtake an earlier one and the peer rejects the index. Nothing on
the wire announces the setting, and a loopback or lossless path never reveals
it, so a host whose WebRTC binding defaults differently can pass every local
test and fail every real transfer.

The transfer is **one-way**. Every message goes from the sender to the
receiver, and the receiver sends nothing back: it verifies what arrives on its
own — each chunk authenticates individually, and the sender's closing `end`
says how much there was — and it closes the transport once it has the file or
gives up. The sender is complete once its last message has left its send
buffer. Neither side is told what the other concluded; whether the file
arrived is for the two people to confirm between themselves, which they do
anyway.

### 7.1 Chunk framing

The payload — in its wire encoding (§6) — is split into `ENCRYPTION_CHUNK_SIZE`
= 128 KiB pieces, and each is sent as one **binary** message, sender to
receiver only:

```
[2 bytes: chunk index, big-endian][12 bytes: nonce][ciphertext][16 bytes: tag]
```

AES-256-GCM under the content key. **The 2-byte index prefix is also passed as
additional authenticated data**, so a receiver rejects a chunk whose index was
altered or whose ciphertext was swapped with another chunk's.

Indices start at 0 and increase by one. The 2-byte field caps a transfer at
65 536 chunks (`MAX_CHUNKS`).

### 7.2 Control messages

Every **text** message the transfer sends is one JSON object, its type in `t`,
and every one goes from the sender to the receiver:

| `t` | Fields | Meaning |
|---|---|---|
| `end` | `chunks`, `bytes` | The payload is complete: its chunk count and wire byte count |
| `abort` | `reason` | The sender is stopping, and why |

```json
{ "t": "end", "chunks": 4, "bytes": 393233 }
{ "t": "abort", "reason": "cancelled" }
```

- `chunks` and `bytes` are non-negative integers, `chunks` at most
  `MAX_CHUNKS` and `bytes` at most `MAX_MESSAGE_SIZE`. A message of a type
  defined here whose fields are malformed is a protocol violation (§7.6).
- A text message that is not a JSON object with a `t` defined here is not
  addressed to the transfer, and a peer MUST ignore it: the link may carry
  other messages beside the transfer.
- `reason` is a short human-readable string. A receiver cuts a longer one at
  200 characters, and reads a missing one as empty. `cancelled` is the reason
  a sender sends when its user cancelled.

### 7.3 Flow control

The sender is paced by the transport alone: it hands the next chunk over only
once the transport has taken the last (a data channel is drained at a 1 MiB
`bufferedAmountLowThreshold`; a framed onion stream's writes complete as the
stream takes them). Nothing comes back to open a window, so a receiver stores
chunks as fast as its storage allows, and what it has taken off the link but
not yet written waits in its memory. A receiver bounds that wait at
`RECEIVE_BACKLOG_MAX_BYTES` (256 MiB) and gives up past it, closing the
transport: nothing it does can slow the sender down, and a browser cannot
refuse a data channel message, so the alternative would be to hold on until
the process dies.

### 7.4 Completion

After the last chunk the sender sends `end` with the chunk count and the
**wire** byte count (post-encoding, pre-encryption), and is complete once
`end` has left its send buffer. It then keeps the transport up until the
receiver hangs up or a linger window passes (10 s on a data channel, 30 s on
an onion stream), so its own close never cuts off what the transport is still
delivering.

The receiver MUST verify that the chunk count matches what it received, that
indices arrived exactly once in order, and that the decrypted wire byte count
matches; then, and only then, it finalizes what it stored. It then closes the
transport, which is the only thing the sender ever hears from it.

Once `end` has checked out, the rest is the receiver's own work: what it still
holds is stored whatever the transport does next, so the sender's close after
its linger, or an `abort` it sends as its user moves on, no longer fails the
transfer.

### 7.5 Receive discipline

Receivers **append in reliable arrival order**. There is no positional or
out-of-order write path: no wire payload has a length known up front, so an
index cannot be turned into an offset. A receiver MUST reject a chunk whose
index is not the next expected one, a duplicate index, a short chunk before the
final one, a malformed length, and a transfer that exceeds `MAX_MESSAGE_SIZE`.
Once `end` has checked out it has stopped reading the transport, so anything
sent after it is never seen.

There is **no whole-file checksum and no manifest**. Integrity rests entirely
on per-chunk AES-GCM authentication with the authenticated index, plus the
completeness checks above.

### 7.6 Abort

- A sender that gives up — cancelled by its user, a source that fails, a
  transport that will not drain — sends `abort` with its reason and closes the
  transport. Sending it is best effort: the receiver's watchdog (§7.7) covers
  one that is lost.
- A receiver that receives `abort` stops at once and reports the sender's
  reason.
- A receiver that gives up — cancelled by its user, a chunk that fails a
  check, a protocol violation, a local failure such as storage, or storage
  that fell `RECEIVE_BACKLOG_MAX_BYTES` behind the link — closes the
  transport. It has no message to send.
- A transport that closes before `end` has arrived is a connection failure for
  the receiver, and an `abort` before it stops the receiver; after a valid
  `end` neither does anything. A transport that closes while the sender still
  holds unsent bytes is a connection failure for the sender.

### 7.7 Stall watchdog

`STALL_TIMEOUT_MS` = 60 s, an idle window rather than an overall deadline, each
side measuring the other:

- The sender fails when the transport will not take the next chunk, or will
  not drain after `end`, within the window: a receiver that stopped reading.
  While it waits on its own input it runs no clock.
- The receiver arms it when the transport opens, resets it on every incoming
  message, and stops it once `end` has checked out: storing what is in hand
  is its own work, not the sender's.

A steadily progressing transfer of any size never trips it.

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
| `RECEIVE_BACKLOG_MAX_BYTES` | 256 MiB |
| `abort` reason | at most 200 characters |

Peer-visible timeouts:

| Timeout | Value |
|---|---|
| Receiver wait for the confirm | 60 s |
| Sender confirmation-code entry | 150 s |
| Receiver wait for the offer | 180 s |
| Sender wait for the answer | 60 s |
| Offer retry interval | 5 s |
| ICE gathering | 5 s |
| Direct attempt, sender | 20 s with a fallback, 120 s without |
| Direct attempt, receiver | 30 s with a fallback, 120 s without |
| Transfer stall (idle) | 60 s |
| Sender linger after `end` | 10 s (data channel), 30 s (onion stream) |
| Sender rotation/wait backstop | 30 min |

The direct-attempt windows run from when each side has the other's code; the
receiver's outlasts the sender's, so the sender's verdict on the route comes
first.

---

## 9. Test vectors

Frozen digests for the two canonicalizations in §4.4 and §4.7. Code that
reproduces both has its field order, version labels, JSON escaping, and
encodings right — which is most of what silently diverges.

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
[`src/lib/nostr/transcript.test.ts`](../src/lib/nostr/transcript.test.ts).
Changing either digest is a breaking change, never an accident.

---

## 10. Where the code is

| Section | Source |
|---|---|
| PIN, hint, transfer id | [`src/lib/crypto/pin.ts`](../src/lib/crypto/pin.ts), [`constants.ts`](../src/lib/crypto/constants.ts) |
| SPAKE2 | [`src/lib/crypto/spake2.ts`](../src/lib/crypto/spake2.ts) |
| Key schedule, confirmation code | [`src/lib/crypto/kdf.ts`](../src/lib/crypto/kdf.ts) |
| Carried codes | [`src/lib/nostr/code-carriage.ts`](../src/lib/nostr/code-carriage.ts), running the Code Exchange session in [`src/lib/code-exchange/`](../src/lib/code-exchange/) |
| AES-GCM framing | [`src/lib/crypto/aes-gcm.ts`](../src/lib/crypto/aes-gcm.ts) |
| Events, tags, filters | [`src/lib/nostr/events.ts`](../src/lib/nostr/events.ts), [`types.ts`](../src/lib/nostr/types.ts) |
| Transcript hashes | [`src/lib/nostr/transcript.ts`](../src/lib/nostr/transcript.ts) |
| Handshake choreography | [`src/hooks/use-pin-send.ts`](../src/hooks/use-pin-send.ts), [`use-pin-receive.ts`](../src/hooks/use-pin-receive.ts) |
| Wire encoding | [`src/lib/transfer-source.ts`](../src/lib/transfer-source.ts) |
| Transfer protocol | [`src/lib/p2p-transfer.ts`](../src/lib/p2p-transfer.ts), over the channel in [`src/lib/duplex-channel.ts`](../src/lib/duplex-channel.ts) or the Tor link in [`src/lib/tor/transfer.ts`](../src/lib/tor/transfer.ts) |

Design rationale for all of the above — why a PAKE, why the PIN is split, what
the confirmation code does and does not cover, the threat model — is in
[ARCHITECTURE.md](ARCHITECTURE.md).
