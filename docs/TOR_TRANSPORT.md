# Tor Onion Transport

The transfer mode with no rendezvous server of any kind. The sending side
publishes an ephemeral **v3 onion service** and mints a one-time password;
those two strings are the whole rendezvous. The receiving side needs no
signaling relay, account, lookup hint, or anything the sender did not hand it
directly; its Tor client still builds circuits through Tor relays.

This document is the **normative specification** for that mode, and it is what
the two implementations agree with each other on:

| Implementation | Where it lives |
| --- | --- |
| The browser tab | this repo — see [TOR_BROWSER.md](./TOR_BROWSER.md) |
| `ptransfer-cli` | [ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli)'s `tor` subcommands — see that repo's `docs/ARCHITECTURE.md` |

Either side of a transfer may be a browser tab or the CLI. Where an
implementation and this document disagree, this document wins.

This is a cross-implementation interoperability contract: the browser and CLI
both implement it. It is versioned separately from
[`INTEROP_PROTOCOL.md`](./INTEROP_PROTOCOL.md), whose
`INTEROP_PROTOCOL_VERSION` covers PIN Exchange and the shared data-channel
layer only. Changes here do not move that version. This mode instead versions
its own handshake (`TOR_HANDSHAKE_VERSION`, currently `1`).

## Changing this document

This repository is where this specification lives; the CLI implements against
it rather than restating it, so editing this file is not by itself a change to
the CLI. What actually binds the two implementations is the short list below —
the rest of this document is the reasoning around it, and rewording that costs
the other side nothing.

| What binds both sides | How a divergence surfaces |
| --- | --- |
| The handshake frames, their order, and their bodies | `TOR_HANDSHAKE_VERSION`, carried in the `hello` and `offer` frames and **refused rather than negotiated** on a mismatch. Bump it for any change to the frames, in lockstep with the CLI. |
| Transfer identity, sealed bodies, key schedule | Nothing to bump: a divergence lands the two sides on different keys, and the seals do not open. |
| The address form and the default port | Nothing to bump: the connection never lands. |
| The framing, the 100 MiB cap, and the wire ceiling's 1 MiB margin | Nothing to bump: each side enforces the bound on what it accepts, so raising it alone only produces failures. |

Everything outside that list is per-implementation detail and lives with its
implementation. webtor-rs owns the browser Tor engine's bridges, directory,
onion lookup and publication, descriptor lifecycle, and circuit behavior; see
its [Onion-Service Architecture](https://github.com/andrewtheguy/webtor-rs/blob/main/docs/ONION_SERVICE_ARCHITECTURE.md).
pTransfer's adapter and stricter browser cache policy are in
[TOR_BROWSER.md](./TOR_BROWSER.md). The CLI documents how it builds its client
from Arti in its own `docs/ARCHITECTURE.md`. None has to be mirrored into the
others, and none belongs in this file.

## What it is for

Nothing about the transfer touches a pTransfer or Nostr relay, and the peers'
networks never connect directly. Tor necessarily exposes per-hop transport
metadata to its own infrastructure, but neither peer learns the other's network
address and that infrastructure receives neither file plaintext nor the
content key. There is no pTransfer or Nostr rendezvous event, though the onion
descriptor remains retrievable by anyone holding the address until it expires.
How each Tor implementation realizes that property is outside this transfer
contract and belongs to webtor-rs or the CLI respectively.

The price is a **100 MiB cap** per transfer — the same ceiling the web app's
relayed data path works under, for the same reasons: both push bytes through
third parties, at a throughput neither controls, and neither can resume, so a
transfer that dies two thirds of the way through starts over. How slow a
circuit actually is varies enormously with the relays it was built from, which
is why the only hard number is that ceiling; below it an implementation is
expected to *say* that a large transfer may crawl, not to refuse it.

### What each layer contributes

Tor authenticates the *service* to the client — the address **is** its public
key — and encrypts the stream end to end, so there is no exit node anywhere in
the path and therefore no TLS. The password adds the other direction: proof the
connecting peer is the intended receiver rather than anyone who came across the
address. File bytes then travel under the same AES-256-GCM chunk format as
every other pTransfer transfer, encrypted a second time inside the Tor stream.

## The address

The service is addressed as `<host>.onion:<port>`, and the default virtual port
is **9735** on both sides. Onion services have their own port space, so this
collides with nothing.

The address is not merely a hostname here: both peers bind their SPAKE2
transcript to that exact string, so two peers who typed the same address in
different letter cases would derive different roots. Both implementations
therefore canonicalize it the same way — **lowercase, always carrying its
port** — and verify the v3 checksum locally before anything touches the
network, since a bootstrap costs tens of seconds to minutes and a typo caught
only afterwards reads as a network failure rather than the input error it is.

That canonical string is what the handshake binds, not what a person is handed.
The port is not a choice either side offers, so **the address handed over
leaves the default port implicit** and reads `<host>.onion`; an implementation
that lets an operator pick another port spells that one out. Both sides accept
either form and both must resolve a missing port to 9735, so the two round-trip
to the same binding.

The identity key is ephemeral. It lives only as long as the sending process (or
tab), and the descriptor it published expires on its own.

## The password

Minted with the same generator PIN Exchange uses: 12 case-sensitive characters
(11 data + 1 position-weighted checksum) from a 55-character alphabet of
letters and digits that excludes the ambiguous `0`, `1`, `I`, `O`, `i`, `l`,
`o`. There are no symbols.

Unlike a PIN, **all 11 data characters are secret**. The twelfth character is
the deterministic checksum. A PIN reserves its leading three data characters
as a public locator so a receiver can find the sender's rendezvous event on a
relay; here there is no signaling relay and nothing public to look anything up
in, so every data character contributes to authentication.

That generator is how *this mode* mints a password. The handshake below does not
require it: it takes an opaque string and derives its SPAKE2 scalar from that. A
web-only caller uses the latitude — Code Exchange's anonymous relay option runs this
same handshake with a password derived from the ECDH secret its own exchange already
established, never shown to a person and never transmitted, and announces the address
over its own encrypted control channel rather than handing the pair over by hand (see
[CODE_EXCHANGE.md](CODE_EXCHANGE.md)). Nothing on the binding list changes for it: no
frame, no bound, no version. An implementation of this document alone neither
implements that option nor meets a peer using it.

## Handshake

The address and the password are the only inputs. All frames are text frames
carrying JSON, tagged by a `type` field, and the version is **refused on
mismatch rather than negotiated**.

```text
receiver -> sender   hello    { version, pakeMessage: pB }
sender   -> receiver offer    { version, pakeMessage: pA, salt }
receiver -> sender   claim    { sealed }            <- the client knows the password
sender   -> receiver confirm  { sealed(metadata) }  <- the service knows it too
receiver -> sender   ready | cancel
```

- `pakeMessage` is a base64 33-byte compressed P-256 point, screened as a valid
  non-identity curve point *before* the scalar multiplication that finishes the
  run.
- `salt` is a base64 16-byte per-connection HKDF salt, generated fresh by the
  sending side for every connection.
- `sealed` is base64 AES-256-GCM ciphertext over a JSON body.

### Transfer identity

It is the same SPAKE2 (RFC 9382, P-256) machinery PIN Exchange uses, with the
relay-shaped parts removed. There is no rendezvous to look up and no
third-party identity to bind, so the **address itself is the transfer
identity**:

```
transferId     = "<host>.onion:<port>"
senderPubkey   = "ptransfer:tor:v1:sender"
receiverPubkey = "ptransfer:tor:v1:receiver"
```

Binding the address is what stops a peer that proxies the handshake through to
a *different* onion service: both ends would derive different roots, and every
seal under them fails.

### Sealed bodies

The seal is the proof; the body only restates what the seal is *about*, so that
a payload lifted from one direction or one address cannot be replayed into
another even if the keys ever collided. Every field is verified by the opener.

| Frame | Body |
| --- | --- |
| claim | `{ type: "claim", version, onion }` |
| confirm | `{ type: "confirm", version, onion, metadata }` |

`metadata` is the same `TransferMetadata` the other modes carry — `contentType`
(always `file`), `fileName`, `fileSize`, `contentEncoding`, `mimeType`.
`fileSize` is the sender's *input* size, a progress hint and never the wire
length; `contentEncoding` is one of `deflate-raw` or `identity` under the same
flow-based rule as every other mode (a single file deflates, a generated ZIP
does not).

### Key schedule

Every key is an HKDF-SHA256 expansion off the SPAKE2 transcript root and the
salt from that connection's `offer`, under labels of its own so a root that came
out of a Tor handshake can never produce a key PIN Exchange would also produce:

| Key | Label | Purpose |
| --- | --- | --- |
| claim | `ptransfer:tor-session:v1:claim` | Seals the receiver's claim (receiver → sender) |
| confirm | `ptransfer:tor-session:v1:confirm` | Seals the sender's confirm, file metadata included |
| content | `ptransfer:tor-session:v1:content` | Encrypts the file chunks |

### Key confirmation

Opening a seal *is* the key confirmation: a wrong password produces two
different roots, and the claim simply fails to open. There is **no confirmation
code** for a human to compare — unlike a PIN, which is short enough to be raced
with a live guess while it is on screen, the address and password are only ever
handed over together as a pair, so there is no race to catch.

A sender that cannot open a claim **hangs up rather than answering**. A peer
that reached the onion service already knows the address was usable, but learns
no file metadata and gets no finer-grained feedback about a wrong password: a
bad password and malformed handshake are deliberately not distinguished.

The service keeps waiting afterwards — the address and password are untouched
by a failed connection, so the real receiver can still come back. A receiver
that authenticates and then declines (`cancel`, e.g. a destination conflict) is
not a failure either and leaves the service waiting the same way.

### Bounds

Anyone who has the address can open the port, so an accepted connection is not
yet a receiver and never gets to hold the service against the real one:

- **20** failed connections, then the sender gives up.
- **5 minutes** for a connection to *authenticate*; a stall counts as a failed
  connection like any other and the sender goes back to waiting. The transfer
  that follows is not on a wall clock — a peer that has proved it knows the
  password is the receiver, and how long its bytes take is unknowable in
  advance — but it is still bound by the transfer layer's idle window, so a
  receiver that stops draining the circuit aborts within a minute.
- **30 minutes** to find a receiver that authenticates. It bounds the *wait*,
  and covers waiting for a connection rather than only the gaps between them,
  so a service nobody ever reaches still stops on its own. It does not bound a
  transfer: a peer that has proved it knows the password is the receiver, and
  cutting it off at an arbitrary minute would be a speed-based size limit in
  disguise. A sender's own shutdown must still work while bytes are moving.

## Framing

A Tor stream is a byte stream, and the transfer choreography needs discrete
messages that keep the binary/text distinction a data channel gives for free.
Each message travels as

```text
[1-byte kind][4-byte big-endian length][payload]
```

with kind `0` for a binary content chunk and `1` for a control string. The
length is capped at one full encrypted chunk — 128 KiB + 30 bytes of overhead —
so a peer cannot make the other side allocate more than the transfer itself
would.

Whoever sends the last message of the conversation waits (up to 30 seconds) for
the peer to close before tearing the stream down: over Tor the close is the
delivery receipt for that final frame. Its absence after the receiver's `ACK` is
reported but is not a transfer failure — by then the file is written and
verified, and only the sender's knowledge of that is in doubt.

## Transfer

Above the framing each implementation runs the same transfer code path it uses
over a WebRTC data channel: 128 KiB AES-256-GCM chunks with the chunk index as
additional authenticated data, a `DONE:<chunks>:<bytes>` trailer, and an `ACK`
once every chunk has authenticated and been written. A single file is deflated
on the wire and restored on receipt; a generated ZIP travels as-is. See
[`INTEROP_PROTOCOL.md`](./INTEROP_PROTOCOL.md) for that layer.

## Limits

- **100 MiB** per transfer, enforced on the *input* when the selection is
  prepared, before anything is published. Both implementations enforce the same
  bound and refuse a larger offer, so raising it on one side alone would only
  produce failures.
- Anything above **1 MiB** is a *suggestion*, not a limit. A sender is expected
  to tell its operator that throughput over a circuit is unpredictable — the
  same size can arrive in moments or crawl, depending on the relays the circuit
  was built from — and that a transfer which drops starts over, and then to
  send it anyway. A fixed ceiling would refuse transfers that would have
  finished fine; only the operator knows what the file is worth waiting for.
- The wire ceiling carries a **1 MiB margin** over the cap: deflate grows
  incompressible input slightly and a ZIP adds per-entry headers. The receiver
  caps *inflated* output at the same ceiling as a decompression-bomb guard.
- Because that ceiling is a fixed constant on both sides, a sender must bound
  its own wire size **before publishing**, not discover it while producing
  bytes. The input size does not answer that question: a ZIP charges a header
  pair and the entry path for every file it holds, so a selection of many tiny
  files can sit far under the input cap and still not fit. A sender projects
  an upper bound — per-entry overhead plus what deflate can add — and refuses
  the selection up front. Finding out later costs a bootstrap, a handshake,
  and, on a transport with no resume, the whole transfer.
- The service answers only while the sending process (or tab) is running.
- No resume: a dropped transfer starts over.
