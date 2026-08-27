# Tor Onion Transport

The transfer mode with no rendezvous server of any kind. The sending side
publishes an ephemeral **v3 onion service** and mints a one-time password;
those two strings are the whole rendezvous. The receiving side needs no relay,
no account, no lookup hint, and nothing the sender did not hand it directly.

This document is the **normative specification** for that mode, and it is what
the two implementations agree with each other on:

| Implementation | Where it lives |
| --- | --- |
| The browser tab | this repo — see [TOR_BROWSER.md](./TOR_BROWSER.md) |
| `ptransfer-cli` | [ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli)'s `tor` subcommands, behind its non-default `tor` cargo feature — see that repo's `docs/ARCHITECTURE.md` |

Either side of a transfer may be a browser tab or the CLI. Where an
implementation and this document disagree, this document wins.

It is deliberately **outside the interop protocol**: nothing here is specified
by [`INTEROP_PROTOCOL.md`](./INTEROP_PROTOCOL.md), which covers PIN Exchange and
the shared data-channel layer only, and nothing here moves that document's
version. What this mode versions instead is its own handshake
(`TOR_HANDSHAKE_VERSION`, currently `1`).

## What it is for

Nothing about the transfer touches a pTransfer or Nostr relay, and the two
peers' networks never connect to each other directly. What it does touch is Tor
itself: whatever gets each peer onto the network, the relays the circuits are
built from, and the HSDirs that carry the descriptor. Those see transport
metadata — never plaintext, never the content key, and no single one of them
sees both peers. The two peers meet at a rendezvous point inside the Tor
network, so neither learns the other's address and nothing published anywhere
can be correlated with the transfer afterwards.

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

Unlike a PIN, **all 12 characters are secret**. A PIN reserves its leading three
as a public locator so a receiver can find the sender's rendezvous event on a
relay; here there is no relay and nothing public to look anything up in, so the
whole string authenticates.

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

A sender that cannot open a claim **hangs up rather than answering**, so a
guesser learns only that the connection ended, never which of the two inputs
was wrong. A wrong password and a peer speaking gibberish are deliberately not
distinguished: the difference is only ever useful to whoever is guessing.

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
- **30 minutes** overall, wrapping the accept loop *including* connections in
  progress, so neither the deadline nor a shutdown is blocked by a peer that
  opens the port and says nothing.

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

Above the framing the transfer is *the same code* both implementations run over
a WebRTC data channel: 128 KiB AES-256-GCM chunks with the chunk index as
additional authenticated data, a `DONE:<chunks>:<bytes>` trailer, and an `ACK`
once every chunk has authenticated and been written. A single file is deflated
on the wire and restored on receipt; a generated ZIP travels as-is. See
[`INTEROP_PROTOCOL.md`](./INTEROP_PROTOCOL.md) for that layer.

## Limits

- **100 MiB** per transfer, enforced on the *input* when the selection is
  prepared, before anything is published. Both implementations enforce the same
  bound and refuse a larger offer, so raising it on one side alone would only
  produce failures. A browser receiver has a second reason to sit here: a
  payload this size or smaller is taken entirely in memory, so the transfer
  never depends on OPFS `createWritable`, which not every engine has.
- Anything above **1 MiB** is a *suggestion*, not a limit. A sender is expected
  to tell its operator that throughput over a circuit is unpredictable — the
  same size can arrive in moments or crawl, depending on the relays the circuit
  was built from — and that a transfer which drops starts over, and then to
  send it anyway. A fixed ceiling would refuse transfers that would have
  finished fine; only the operator knows what the file is worth waiting for.
- The wire ceiling carries a **1 MiB margin** over the cap: deflate grows
  incompressible input slightly and a ZIP adds per-entry headers, neither of
  which is known until the bytes are produced. The receiver caps *inflated*
  output at the same ceiling as a decompression-bomb guard.
- The service answers only while the sending process (or tab) is running.
- No resume: a dropped transfer starts over.
- A first bootstrap can take minutes, and in a browser tab usually does.
