# Tor Onion Transport

The third transfer mode. The sending side publishes a **v3 onion service from
the browser tab** and mints a one-time password; those two strings are the whole
rendezvous. The receiver needs no relay, no account, no lookup hint, and nothing
the sender did not hand it directly.

It is deliberately **outside the interop protocol**: nothing here is specified by
[`INTEROP_PROTOCOL.md`](./INTEROP_PROTOCOL.md), which covers PIN Exchange and the
shared data-channel layer only. What this mode has to agree with is
[ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli)'s `tor`
subcommands, which speak the same handshake and framing behind its non-default
`tor` cargo feature. Either side can be a browser tab or the CLI.

## What it is for

Nothing about the transfer touches a pTransfer or Nostr relay, and the two
networks never connect to each other directly. What it does touch is Tor
itself: a Snowflake bridge to get in (the `webrtc` bridge uses the same STUN
servers ICE does; the default `websocket` one uses none), the relays the
circuits are built from, and the HSDirs that carry the descriptor. Those see
transport metadata — never plaintext, never the content key, and no single one
of them sees both peers. The two peers meet at a rendezvous point inside the
Tor network, so neither learns the other's address and nothing published
anywhere can be correlated with the transfer afterwards. The price is
speed and a **1 MiB cap** per transfer: a Tor circuit is slow enough that a
large transfer would want resume support, which this has none of.

## The browser as an onion service

The Tor client is [`@andrewtheguy/webtor-wasm`](https://github.com/andrewtheguy/webtor-rs),
a Tor implementation compiled to WASM that builds its own circuits from the
page. Sending runs it as a *service*: the tab generates the identity keypair,
derives the address from it, establishes introduction points with
`ESTABLISH_INTRO`, signs a descriptor naming them, and uploads it to the
responsible HSDirs. Every `INTRODUCE2` that arrives afterwards is answered by
building a circuit to the client's rendezvous point and completing the hs-ntor
handshake as the responder. Receiving runs the client half: compute the time
period and shared random value, blind the service key, fetch the descriptor from
an HSDir, establish a rendezvous cookie, and send `INTRODUCE1`.

There is no exit node in any of that, and therefore no TLS: every destination is
an onion address, which commits to the service key, and the circuit is encrypted
end to end.

The identity key lives in the tab and dies with it. Closing the page destroys
the address for good, and the descriptor it published expires on its own.

### Reaching the Tor network

Every circuit starts at a **Snowflake bridge**, which is also how the tab
reaches the network at all. Both sides pick one independently — they only meet
inside Tor, so the choices need not match:

| Bridge | What it is |
| --- | --- |
| `websocket` (default) | A direct WebSocket to one fixed bridge endpoint. No broker, no volunteer proxy, no STUN, and the faster of the two. |
| `webrtc` | A volunteer proxy brokered over HTTPS, using the same STUN servers ICE uses. Harder to block, and worth switching to when the WebSocket endpoint cannot be reached. |

The slowest part of a cold start is not the rendezvous: the client fetches the
consensus and *every* HSDir microdescriptor one hop from the bridge, because a
relay's position on the hash ring comes from the ed25519 identity in its
microdescriptor. That download is cached in IndexedDB
(`src/lib/tor/directory-cache.ts`) and re-verified against the pinned directory
authorities on the next load, so a second transfer in the same browser starts in
seconds.

A consensus stays valid for three hours, but a seed is only reused while it also
belongs to the *current* onion-service time period. Where a descriptor lives is
derived from the consensus's own `valid-after`, and the period rotates on a
fixed daily boundary: a seed from before the rotation is still perfectly valid
and still describes the ring the network has stopped using, so a service seeded
with it would publish to one ring while a client asked the other, and every
HSDir tried would answer 404 with no hint as to why. A seed in that state — or
one within ten minutes of expiring — is passed over and the directory downloaded
again, which costs time and never correctness.

The same mismatch can arrive from the network rather than the cache, when a
bridge or relay serves a consensus an hour behind. Nothing on this side can fix
that, so each peer instead logs the consensus it bootstrapped with and the time
period that consensus places it in:

```text
[tor] Directory: consensus valid 2026-08-27T12:00:00.000Z to 2026-08-27T15:00:00.000Z,
      onion time period 20692 (both peers must be in the same period)
```

Comparing that one number across the two peers is the difference between a
diagnosable failure and a silent one.

## The password

Minted with the same generator PIN Exchange uses: 12 case-sensitive characters
(11 data + 1 checksum) from a 55-character alphabet that excludes the ambiguous
`0`, `1`, `I`, `O`, `i`, `l`, `o`.

Unlike a PIN, **all 12 characters are secret**. A PIN reserves its leading three
as a public locator so a receiver can find the sender's rendezvous event on a
relay; here there is no relay and nothing public to look anything up in, so the
whole string authenticates.

## Handshake

The address and the password are the only inputs. The frames are JSON text
frames, and the protocol version (`TOR_HANDSHAKE_VERSION`, currently `1`) is
refused on mismatch rather than negotiated.

```text
receiver -> sender   hello    { version, pakeMessage: pB }
sender   -> receiver offer    { version, pakeMessage: pA, salt }
receiver -> sender   claim    { sealed }            <- the client knows the password
sender   -> receiver confirm  { sealed(metadata) }  <- the service knows it too
receiver -> sender   ready | cancel
```

It is the same SPAKE2 (RFC 9382, P-256) machinery PIN Exchange uses, with the
relay-shaped parts removed. There is no rendezvous to look up and no third-party
identity to bind, so the **address itself is the transfer identity**:

```
transferId    = "<host>.onion:<port>"
senderPubkey  = "ptransfer:tor:v1:sender"
receiverPubkey = "ptransfer:tor:v1:receiver"
```

Binding the address is what stops a peer that proxies the handshake through to a
*different* onion service from sharing a root with either side. Both peers must
therefore agree on one spelling of it, which is why the address is canonicalized
to lowercase and always carries its port (`src/lib/tor/onion-address.ts`, which
also verifies the v3 checksum locally — before a bootstrap that costs minutes).

Every key is an HKDF-SHA256 expansion off the SPAKE2 transcript root and the
salt the service generated for that connection, under labels of its own so a
root that came out of a Tor handshake can never produce a key PIN Exchange would
also produce:

| Key | Label | Purpose |
| --- | --- | --- |
| claim | `ptransfer:tor-session:v1:claim` | Seals the receiver's claim (receiver → sender) |
| confirm | `ptransfer:tor-session:v1:confirm` | Seals the sender's confirm, file metadata included |
| content | `ptransfer:tor-session:v1:content` | Encrypts the file chunks |

Opening a seal *is* the key confirmation: a wrong password produces two
different roots, and the claim simply fails to open. There is **no confirmation
code** for a human to compare — unlike a PIN, which is short enough to be raced
with a live guess while it is on screen, the address and password are only ever
handed over together as a pair.

A sender that cannot open a claim hangs up rather than answering, so a guesser
learns only that the connection ended, never which of the two inputs was wrong.
The service keeps waiting afterwards: the address and password are untouched by
a failed connection, so the real receiver can still come back. What that costs
is bounded — 20 failed connections, five minutes per connection, and 30 minutes
overall.

## Framing and transfer

A Tor stream is a byte stream, and the transfer choreography needs discrete
messages that keep the binary/text distinction a data channel gives for free.
Each message travels as

```text
[1-byte kind][4-byte big-endian length][payload]
```

with kind `0` for a binary content chunk and `1` for a control string. The length
is capped at one full encrypted chunk (128 KiB + 30 bytes of overhead), so a peer
cannot make the other side allocate more than the transfer itself would.

Above that framing the transfer is *the same code* as the WebRTC data path
(`src/lib/p2p-transfer.ts`): 128 KiB AES-256-GCM chunks with the chunk index as
additional authenticated data, a `DONE:<chunks>:<bytes>` trailer, and an `ACK`
once every chunk has authenticated and been written. A single file is deflated on
the wire and restored on receipt; a generated ZIP travels as-is.

Whoever sends the last message of the conversation waits for the peer to close
before tearing the stream down: over Tor the close is the delivery receipt for
that final frame.

## Limits

- **1 MiB** per transfer, checked against the selected input before anything is
  published. The CLI enforces the same bound and refuses a larger offer, so
  raising it on one side alone would only produce failures.
- The service answers only while the tab is open.
- No resume: a dropped transfer starts over.
- A first bootstrap in a browser can take minutes over the public bridge.

## Testing it

`bun run test:live:tor` runs both directions against ptransfer-cli over real
circuits — the CLI publishes a service the page downloads from, then the page
publishes one the CLI fetches — so a failure names the side that is wrong.

```bash
# the CLI, built with the tor feature
cd ../ptransfer-cli && cargo build --release --all-features

# a local Snowflake bridge, so the directory download is local
cd ../webtor-rs && scripts/local-bridge/bridge.sh start

cd ../ptransfer
eval "$(../webtor-rs/scripts/local-bridge/bridge.sh env)" && bun run test:live:tor
```

`ONLY=cli-to-web` or `ONLY=web-to-cli` runs one leg. Without a local bridge it
still works, on the public one, and takes considerably longer.

For manual testing, the same two variables reach the app as
`VITE_TOR_BRIDGE_URL` and `VITE_TOR_BRIDGE_FINGERPRINT` (both or neither — a URL
with no identity would be a request to trust whatever answers). A directory
snapshot served at `/tor-directory.json` is used when one is present; build one
shortly before testing, since a consensus expires in three hours:

```bash
bun ../webtor-rs/tests/tools/fetch-directory.ts public/tor-directory.json
```
