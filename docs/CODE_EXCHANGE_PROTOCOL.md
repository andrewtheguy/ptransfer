# Code Exchange Protocol

The transfer mode with no signaling server of any kind. The sending side shows
a **code**; a person carries it to the receiving side, which answers with a
**response code** that the same person carries back. No relay sees either one,
and the sender's own act of taking the response in is what admits a receiver.

This document is the **normative specification** for that mode, and it is what
the two implementations agree with each other on:

| Implementation | Where it lives |
| --- | --- |
| The browser tab | this repo — see [ARCHITECTURE.md](./ARCHITECTURE.md#code-exchange-signaling-srclibcode-signalingts) |
| `ptransfer-cli` | [ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli)'s `code` subcommands — see that repo's `docs/ARCHITECTURE.md` |

Either side of a transfer may be a browser tab or the CLI. Where an
implementation and this document disagree, this document wins. The
user-facing guide to the same mode is [CODE_EXCHANGE.md](./CODE_EXCHANGE.md).

This is a cross-implementation interoperability contract, versioned separately
from [`INTEROP_PROTOCOL.md`](./INTEROP_PROTOCOL.md), whose
`INTEROP_PROTOCOL_VERSION` covers PIN Exchange and the shared data-channel
layer. Changes here do not move that version. What Code Exchange **does** share
with it is §7 of that document — the 128 KiB chunk framing, `DONE`, and `ACK`
that every direct transfer runs once a data channel is open — and that part is
governed there, not here.

## Changing this document

This repository is where this specification lives; the CLI implements against
it rather than restating it, so editing this file is not by itself a change to
the CLI. What binds the two implementations is the short list below — the rest
of this document is the reasoning around it, and rewording that costs the
other side nothing.

| What binds both sides | How a divergence surfaces |
| --- | --- |
| The PT01 container: magic, obfuscation seed and keystream, encoding pipeline | The container's own version is its `PT01` magic, refused rather than negotiated. A drift in the seed or keystream reads as "that code is not from the last hour or two". |
| The payload fields and their offer-only / answer-only rules | A payload carrying the wrong field set is malformed, and both sides say so. |
| The key schedule and both transcript digests (§3) | Nothing to bump: a divergence lands the two sides on different keys, the confirmation tag mismatches, and the sender refuses the response. |
| The anonymous fallback's session derivation, control events, and messages (§5) | Nothing to bump: a divergence means the two never meet on the control channel, or the onion handshake never authenticates. |
| The 100 MiB fallback cap and its 1 MiB wire margin | Nothing to bump: each side enforces the bound on what it accepts, so raising it alone only produces failures. |

There is no coordination integer here, and none is needed. Every way the two
sides could drift apart on that list fails closed and says so, which is why
this mode is versioned like [ANONYMOUS_SIGNALING.md](./ANONYMOUS_SIGNALING.md)
rather than like PIN Exchange, whose rotation windows and guessing budgets can
diverge in silence.

Everything outside that list is per-implementation detail. How a code is
carried to the other device — a grid of QR codes and a camera in the browser,
copy/paste text in both — is not part of this contract; see *Carrying the
codes* below.

## 1. The PT01 container

Both codes travel in one container:

```text
[ "PT01" ][ xorObfuscate( [ "mag!" ][ deflate-raw(JSON) ], hourly seed ) ]
```

- **Outer magic**, 4 plaintext bytes: `PT01` (`0x50 0x54 0x30 0x31`). It is the
  container's version, and a reader that does not recognize it refuses the code
  rather than guessing.
- **Inner magic**, 4 obfuscated bytes: `mag!` (`0x6d 0x61 0x67 0x21`). Checked
  first, so a candidate seed is ruled out for four bytes rather than a whole
  buffer.
- **Payload**: the JSON of §2, compressed with **raw DEFLATE** (RFC 1951, no
  zlib or gzip wrapper).

### 1.1 Obfuscation

The obfuscation is **not encryption and is not a security control**. It exists
so a code that lands in a chat log does not read as an SDP offer, and so a
stale one stops decoding on its own. Everything that actually protects the
transfer is in §3.

The seed changes hourly:

```text
bucketEpoch = floor(unix_seconds / 3600)
h    = 0x9e3779b9 XOR bucketEpoch          # all arithmetic is 32-bit
h    = (h XOR (h >>> 16)) * 0x85ebca6b     # wrapping multiply
h    = (h XOR (h >>> 13)) * 0xc2b2ae35
seed = (h XOR (h >>> 16))
```

`>>>` is a logical (unsigned) shift, and the multiplies wrap at 32 bits
(JavaScript's `Math.imul`). The keystream is xorshift32, advanced once per
byte before it is used:

```text
state ^= state << 13
state ^= state >>> 17
state ^= state << 5
out[i] = in[i] XOR (state AND 0xff)
```

### 1.2 Parse window

A reader tries the **current and the immediately previous** hourly bucket — a
two-hour window that tolerates a sender whose clock falls into the reader's
previous bucket, and which is deliberately not symmetric: a sender in the
reader's *next* bucket cannot be decoded.

Parseability is not validity. A payload that decodes is still rejected by the
TTL in §2.

## 2. The signaling payload

JSON, with these fields:

| Field | Type | Present on |
| --- | --- | --- |
| `type` | `"offer"` \| `"answer"` | both |
| `sdp` | string | both |
| `candidates` | array of SDP `candidate:` strings | both |
| `createdAt` | integer, milliseconds since the epoch | both |
| `publicKey` | array of 65 byte values | both |
| `confirm` | base64 of the 16-byte tag (§3.2) | answer only, **required** |
| `fileName` | non-empty string | offer only |
| `fileSize` | non-negative integer, the **input** size | offer only |
| `contentEncoding` | `"deflate-raw"` \| `"identity"` | offer only |
| `mimeType` | string | offer only |
| `salt` | array of 16 byte values | offer only |
| `relays` | array of `wss://` URLs | offer only, optional |
| `anon` | `true` | offer only, optional |

Rules both sides enforce:

- A payload whose `publicKey` is not 65 bytes, or whose first byte is not
  `0x04`, is malformed. It is an **uncompressed SEC1 P-256 point**.
- An offer carrying `confirm`, or an answer carrying any offer-only field, is
  malformed. An answer without a well-formed `confirm` is malformed — there
  would be nothing for the sender to check it against, which is the mode's
  confirmation step.
- `anon` is offer-only and only ever `true`. `false` would describe the
  fallback an offer is *not*, which nothing writes.
- `relays` and `anon` are mutually exclusive: they select the two alternative
  fallbacks, and an offer carrying both would ask the receiver to choose.
- An offer must describe what it is offering — `salt`, `fileName`, `fileSize`,
  `contentEncoding` — and a receiver refuses one that does not. Where it does
  so is an implementation's own business: one checks the container, the other
  checks as it acts on the fields, and no sender produces such an offer.
- `contentEncoding` follows the flow-based rule of
  [INTEROP_PROTOCOL.md §6](./INTEROP_PROTOCOL.md#6-wire-encoding): a single
  file is `deflate-raw`, a generated ZIP is `identity`. Any other value is
  rejected.
- `fileSize` is a progress hint, never a bound. The authoritative wire count is
  `DONE`.

**TTL.** `TRANSFER_EXPIRATION_MS` is 3 600 000 (1 hour). The receiver refuses
an offer older than that. The sender enforces the same bound against **its own
offer's** `createdAt` rather than against the response's, so a response is
judged by the session it answers.

## 3. Key schedule

Both sides mint an ephemeral P-256 key pair per exchange; the offer and the
answer carry the two public keys. The ECDH shared secret — the **x coordinate**
of the agreed point, 32 bytes — is the input keying material for everything
below, with the **offer's `salt`** as the HKDF-SHA256 salt.

| Derivation | info | Output |
| --- | --- | --- |
| Content key | `ptransfer-mutual` | AES-256-GCM key for the direct data channel |
| Answer confirmation tag | see §3.2 | 16 bytes |
| Relay session | `ptransfer-nostr-file:v1:session` | 48 bytes → §5.1 |
| Onion password | `ptransfer-code-exchange:v1:onion-password` | 32 bytes → §5.3 |

ECDH by itself authenticates nobody. What authenticates this exchange is the
path the offer took: a code handed over by a person, and a response the sender
took in itself.

### 3.1 Transcript digests

```text
offerHash  = hex( SHA-256( the offer's PT01 container bytes ) )
answerHash = hex( SHA-256( utf8( JSON.stringify([
               "ptransfer:code-exchange-answer-transcript:v1",
               type, sdp, candidates, createdAt, hex(publicKey) ])) ) )
```

The **offer** digest hashes the container bytes rather than a re-serialization
of the parsed fields. Every path delivers those bytes unmodified, so the digest
commits to the whole offer — including any field a future reader would not know
to canonicalize, `anon` and `relays` among them.

The **answer** digest cannot do the same, because the tag it is bound to lives
inside the container it would have to cover. It hashes a canonical JSON array
instead: element order is fixed here rather than left to key ordering, and JSON
string escaping keeps one field's value from forging a delimiter into the next.
It covers every field the sender acts on, and necessarily not `confirm` itself.

### 3.2 The answer confirmation tag

```text
info = "ptransfer:code-exchange:v1:answer-confirm" + "|" + offerHash + "|" + answerHash
tag  = HKDF-SHA256(secret, salt = offer salt, info, 16 bytes)
```

Both digests are fixed-length hex, so `|` cannot occur inside a field and the
join is unambiguous.

The receiver builds its answer payload, hashes **that payload**, derives the
tag over the result, and only then encodes it into the answer — so the
transcript and the encoded answer cannot drift apart. The sender recomputes the
tag from its *own* offer bytes and the answer it parsed, compares in constant
time, and refuses a mismatch **before** it applies a signal, derives the
content key, or moves a byte.

Producing a valid tag takes having held this offer, having completed the
agreement against the key inside it, *and* sending exactly the answer that was
signed. So an answer from a different transfer, an old answer replayed, and an
answer whose SDP or candidates were altered on the way back are all refused
outright rather than surfacing later as a connection that never opens.

It does not raise the bound the mode already has: whoever captured the offer
can produce a valid response of their own. The sender's own scan or paste is
what selects the recipient, exactly as typing the short code does in PIN
Exchange.

## 4. The direct transfer

The sender creates the data channel; the receiver answers. Both then run the
shared transfer layer of
[INTEROP_PROTOCOL.md §7](./INTEROP_PROTOCOL.md#7-data-channel-transfer)
unchanged — ordered and reliable, 128 KiB AES-256-GCM chunks under the content
key, `DONE:<chunks>:<bytes>`, then `ACK` — with the wire encoding of §6 there.
Nothing about that layer is specific to how the two sides met.

ICE is STUN-only in both implementations; no TURN is configured. Candidates are
gathered before a code is shown rather than trickled, because there is no
channel to trickle them over.

## 5. The anonymous fallback

An offer carrying `anon: true` asks for this, and it is the sender's switch
alone: the receiving side has nothing to turn on and nothing to agree in
advance. It runs only when the direct WebRTC route could not be established.

Two things move, and nothing else does. The **control channel** goes to the
onion-service Nostr relay pool of
[ANONYMOUS_SIGNALING.md](./ANONYMOUS_SIGNALING.md) — the same pool, the same
`ws://<v3 address>.onion` socket rule — and the **file** goes over a temporary
v3 onion service the sender publishes, carried by the handshake and framing of
[TOR_TRANSPORT.md](./TOR_TRANSPORT.md). An anonymous offer never names clearnet
relays, because that pool is a constant on both sides.

The other fallback — the clearnet Nostr file relay an ordinary offer's `relays`
list names — is carried by both implementations, and is specified in
[NOSTR_FILE_RELAY.md](./NOSTR_FILE_RELAY.md) rather than here: what this
contract fixes about it is the `relays` field of §2 and its exclusivity with
`anon`, and everything downstream of that — the derived session of §5.1, the
control channel of §5.2, the manifest, the chunk events — belongs to that
document. An implementation that does not carry it mints offers without a
`relays` list, and a failed direct route ends such a transfer.

### 5.1 The derived session

```text
bits       = HKDF-SHA256(secret, salt = offer salt,
                         info = "ptransfer-nostr-file:v1:session", 48 bytes)
transferId = hex(bits[0..16])                  # 32 lowercase hex characters
fileKey    = bits[16..48]                      # 32 bytes
controlKey = HKDF-SHA256(fileKey, salt = utf8(transferId),
                         info = "ptransfer-nostr-file:v1:control", 32 bytes)
```

Nothing about the session travels in a code. Relays see an opaque tag namespace
and ciphertext.

### 5.2 The control channel

Addressable **kind 30078** events on the onion relay pool:

| Tag | Value |
| --- | --- |
| `d` | `<transferId>:ctl:<role>:<n>` — `role` is `sender` or `receiver`, `n` counts that side's messages from 1 |
| `x` | `<transferId>:ctl` — what both sides subscribe to |
| `expiration` | `floor((offer.createdAt + TRANSFER_EXPIRATION_MS) / 1000)`, NIP-40 |

Content is base64 of

```text
nonce(12) ‖ ciphertext ‖ tag(16)
```

AES-256-GCM under `controlKey` over `deflate-raw(JSON)`, with

```text
aad = utf8("ptransfer-nostr-file:v1:ctl:" + transferId + ":" + role)
```

The AAD binds every message to the transfer **and** to the sending role, so a
receiver's message can never be replayed as a sender's. Each side subscribes
with `#x` and a `since` of `floor(offer.createdAt / 1000)`, and reads the
peer's messages by their `d` prefix; the events are retained, so a side that
was still bootstrapping when the peer published finds the message in the
backlog.

Two messages cross it:

```json
{ "t": "hello", "n": 1 }                                 // receiver → sender
{ "t": "onion", "n": 1, "onion": "<host>.onion:<port>" } // sender → receiver
```

`hello` is the receiver saying the direct route is dead. A sender still
watching may use it to cut its direct attempt short; ignoring it is also
correct, and costs only the rest of that window.

### 5.3 The onion service

The Tor transfer mode hands a person two values. Neither is handed over here:

- The **password** is `base64(HKDF-SHA256(secret, salt = offer salt, info =
  "ptransfer-code-exchange:v1:onion-password", 32 bytes))`, derived on both
  devices and never transmitted. It is derived key material rather than a
  human-length string, so the online-guessing bounds such a password needs do
  not apply to it. It drops into the SPAKE2 handshake of
  [TOR_TRANSPORT.md](./TOR_TRANSPORT.md) unchanged, as an opaque string.
- The **address** cannot be derived — the Tor client mints an ephemeral service
  identity — so it is announced over the control channel of §5.2, sealed under
  a key from the same secret. The announced string is the exact
  `<host>.onion:<port>` both sides bind the handshake transcript to, at the
  transport's default port.

**The ordering is the security property.** The sender cannot reach the shared
secret before it holds the receiver's public key, which exists only inside a
response the sender took in itself. Until then there is nothing published, no
address to announce, and no password that would open the handshake. A captured
offer still yields a response an attacker can build on their own key, and the
sender still publishes only to the response it accepted and verified.

### 5.4 Bounds

- The fallback is capped at **100 MiB** of input (`SLOW_TRANSPORT_MAX_BYTES`,
  the same ceiling the Tor transfer mode has), with the same **1 MiB** wire
  margin over it for deflate and ZIP overhead. A sender refuses a larger
  selection while it is still a selection, before a code is shown; a receiver
  refuses a larger one at the handshake.
- The receiver checks the handshake's metadata against what the offer said —
  name, size, MIME type, content encoding, content type — and refuses a
  mismatch. Whoever completed the handshake is the sender, which is exactly why
  it is worth checking: the receiver agreed to the file the code described and
  has no other way to notice being handed a different one.
- Everything must finish inside the session TTL of §2.

## 6. Carrying the codes

How a code reaches the other device is not part of this contract. What is:

- **Copy/paste** is base64 of exactly the container bytes of §1, and both
  implementations carry it. Whitespace and line wrapping around it are ignored.
- **QR** is browser-only today: the offer is chunked across URL QR codes and
  the answer is a single binary QR. The chunking, its CRC-32, and the URL form
  are specified in [ARCHITECTURE.md](./ARCHITECTURE.md#code-exchange-signaling-srclibcode-signalingts).
  `ptransfer-cli` carries the same container as text and interoperates through
  the copy/paste half; drawing the offer grid in a terminal is on its roadmap,
  reading either QR back is not, for want of a camera. So an answer reaches a
  CLI as text however its offer travelled.

Because the offer digest of §3.1 covers the container bytes and every carriage
delivers them unmodified — copy/paste is base64 of exactly them, the chunked QR
path reassembles them under a CRC-32 — the two sides agree on the same digest
whichever way the code travelled.

## 7. Constants

| Name | Value |
| --- | --- |
| Outer magic | `PT01` |
| Inner magic | `mag!` |
| Obfuscation bucket | 3600 s |
| Obfuscation base seed | `0x9e3779b9` |
| Obfuscation parse window | current + 1 previous bucket |
| `TRANSFER_EXPIRATION_MS` | 3 600 000 |
| Public key | 65 bytes, uncompressed P-256 |
| `SALT_LENGTH` | 16 bytes |
| `ANSWER_CONFIRMATION_BYTES` | 16 |
| Control event kind | 30078 |
| Onion password | 32 bytes, base64 |
| Fallback cap | 100 MiB input, +1 MiB wire margin |

Timeouts are local policy rather than contract. For reference, the reference
implementation gives a direct attempt 20 s when a fallback is available and
120 s when it is not, and a receiver 120 s either way, since its wait starts
before the sender has even seen the response.

## 8. Test vectors

Frozen digests, so a field order, a version label, an encoding, or a JSON
escaping rule cannot drift without a test saying so.

### 8.1 Obfuscation seed

| `bucketEpoch` | seed |
| --- | --- |
| 0 | `0x92ca2f0e` |
| 1 | `0x36deb503` |
| 485000 | `0xd0d4437a` |

The first eight keystream bytes for bucket `0` — which pin the xorshift itself,
not only the seed — are `251, 137, 246, 139, 171, 163, 130, 141`.

### 8.2 Answer transcript hash

Input:

```json
{
  "type": "answer",
  "sdp": "v=0\r\na=answer\r\n",
  "candidates": ["candidate:1 1 udp 2130706431 192.0.2.1 5000 typ host"],
  "createdAt": 1700000000000,
  "publicKey": [0, 1, 2, "…", 64]
}
```

with `publicKey` the 65 bytes `0x00..0x40` in order:

```text
1e1498e7af0eefe6d37a4e2691302990d3fa68e7e80b0d2edc67198b828c2e21
```

### 8.3 Key schedule

With the shared secret `0x00..0x1f` (32 bytes) and the offer salt sixteen
`0x07` bytes:

| Derivation | Value |
| --- | --- |
| Content key | `bdf9708e97a719ea15bc3e19e4ec6e2092a04a3b9cd375a7bd796764c5d91e77` |
| Relay `transferId` | `c05587dba544d9543610d42f7b7b640d` |
| Relay `fileKey` | `9ff98dad3dff5e42b0ca21a7cdabc2e135b8d50da09f0dc42c6fe31edef7f6e2` |
| `controlKey` | `e62e943897153bd50efa915d454c71ca1a71b01e3441129e981551c7a430698b` |
| Onion password | `qwqg1Up94u8ObvUaqx7s1a9x7rGNS4rQANrbp5WQBCc=` |
| Answer tag, `offerHash` = 32 × `aa`, `answerHash` = 32 × `bb` | `ca43435529678169b0aed77536d8734a` |
