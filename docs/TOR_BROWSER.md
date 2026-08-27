# Tor Onion Transport in the Browser

How this app implements [TOR_TRANSPORT.md](./TOR_TRANSPORT.md). The spec is
shared with [ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli) and
either side of a transfer may be a browser tab or the CLI; everything below is
what the browser half does that the CLI does not.

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

The identity key lives in the tab and dies with it. Closing the page destroys
the address for good, and the descriptor it published expires on its own.

`src/lib/tor/onion-address.ts` parses and canonicalizes the address the spec
binds into the SPAKE2 transcript, and verifies the v3 checksum locally — before
a bootstrap that costs minutes.

## Reaching the Tor network

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

### Why a cached seed can still be stale

A consensus stays valid for three hours, but a seed is only reused while it also
belongs to the *current* onion-service time period. Where a descriptor lives is
derived from the consensus's own `valid-after`, and the period rotates on a
fixed daily boundary, so a seed from before the rotation is still perfectly
valid and still describes the ring the network has stopped using. A service
publishes to the period either side of its own as well, which covers one
period of disagreement between the peers; a stale seed spends that slack for
nothing, and past it every HSDir a client tries answers 404 with no hint as to
why. A seed in that state — or one within ten minutes of expiring — is passed
over and the directory downloaded again, which costs time and never
correctness.

The same mismatch can arrive from the network rather than the cache, when a
bridge or relay serves a consensus an hour behind. Nothing on this side can fix
that, so each peer instead logs the consensus it bootstrapped with and the time
period that consensus places it in:

```text
[tor] Directory: consensus valid 2026-08-27T12:00:00.000Z to 2026-08-27T15:00:00.000Z,
      onion time period 20692 (peers more than one period apart cannot reach each other)
```

Comparing that one number across the two peers is the difference between a
diagnosable failure and a silent one.

## Where the code is

| Module | What it does |
| --- | --- |
| `src/lib/tor/webtor.ts`, `client.ts` | Loading the WASM client and bootstrapping it |
| `src/lib/tor/directory-cache.ts` | The IndexedDB consensus/microdescriptor seed |
| `src/lib/tor/onion-address.ts` | Parsing, canonicalizing, and checksum-verifying the address |
| `src/lib/tor/handshake.ts` | The spec's handshake frames and key schedule |
| `src/lib/tor/framing.ts` | `TorFramedStream` — `[kind][length][payload]` over the stream |
| `src/lib/tor/transfer.ts` | The 1 MiB caps and the bridge to the shared transfer layer |
| `src/hooks/use-tor-send.ts`, `use-tor-receive.ts` | The accept loop, its bounds, and the UI state |

Above the framing, `sendFileOverTransport` and `createTransferReceiver` in
`src/lib/p2p-transfer.ts` are the identical code the WebRTC path runs — one
shared wire protocol with two transports, which is why the `TransferTransport`
interface exists.

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

### Testing an unreleased Tor client

`@andrewtheguy/webtor-wasm` is installed from a release tarball, which is the
only form that may be committed: a `file:` dependency resolves on nobody's
machine but the one it was written on. Testing a change to webtor-rs before it
is released means pointing at its build directory for a while, which
`scripts/webtor-source.ts` does in both directions:

```bash
# build the package webtor-rs publishes
cd ../webtor-rs && bun run build

cd ../ptransfer
bun run webtor:local     # -> file:../webtor-rs/webtor-wasm/pkg
bun run webtor:status    # which of the two is installed now
bun run webtor:released  # -> the tarball for webtor-rs's current version
```

Bun links the local package file by file, so rebuilding in webtor-rs is picked
up here with no reinstall; `webtor:local` only has to be run again if a build
adds a file the previous one did not have. `webtor:released` takes a version
(`bun run webtor:released 0.0.1-alpha.13`) and otherwise uses the one in
webtor-rs's `Cargo.toml`, so switching back after a release lands on it.
