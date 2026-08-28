# pTransfer Browser Tor Integration

How this app implements [TOR_TRANSPORT.md](./TOR_TRANSPORT.md). The spec is
shared with [ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli) and
either side of a transfer may be a browser tab or the CLI. This document covers
only pTransfer's browser-side adapter and policy.

## Ownership boundary

The Tor client is [`@andrewtheguy/webtor-wasm`](https://github.com/andrewtheguy/webtor-rs),
a Tor implementation compiled to WASM that builds its own circuits from the
page. webtor-rs owns Snowflake bridge connections, Tor directory validation,
onion-service lookup and publication, descriptor lifecycle, introduction and
rendezvous circuits, and the privacy boundary of those paths. Those details are
documented with their implementation in webtor-rs's
[Onion-Service Architecture](https://github.com/andrewtheguy/webtor-rs/blob/main/docs/ONION_SERVICE_ARCHITECTURE.md).

pTransfer owns what it does with the resulting raw stream. Sending calls
`publishOnionService`, accepts one `OnionStream`, and runs the handshake from
[TOR_TRANSPORT.md](./TOR_TRANSPORT.md). Receiving calls `connectStream` and runs
the other half. pTransfer adds its password authentication, framing, content
keys, transfer limits, failure bounds, UI state, and browser cache policy;
none of those belongs to webtor-rs.

`src/lib/tor/onion-address.ts` parses and canonicalizes the address the spec
binds into the SPAKE2 transcript, and verifies the v3 checksum locally before
starting a network bootstrap.

## Bridge selection and bootstrap

The UI exposes webtor-rs's `websocket` and `webrtc` Snowflake choices and passes
the selection to `WebtorClient.create`. The bridge paths and their security and
availability tradeoffs are defined in webtor-rs, not here. The two transfer
sides choose independently because they meet only inside Tor.

`src/lib/tor/webtor.ts` loads the WASM package lazily, so visitors who never use
a Tor-backed feature do not download it. `src/lib/tor/client.ts` supplies the
selected bridge, the application's STUN URLs when WebRTC Snowflake needs them,
an optional authenticated development bridge, and the best directory seed the
application has.

## Directory cache policy

webtor-rs defines the contents, versioning, and cryptographic validation of
`directoryCache()` and `directorySeed`. pTransfer persists that opaque value in
IndexedDB through `src/lib/tor/directory-cache.ts`, or loads a deployment-time
snapshot from `/tor-directory.json`. Before passing either value back to
webtor-rs, pTransfer applies a stricter freshness rule that is specific to this
application.

What gets persisted is whatever webtor-rs downloads, as it downloads it:
`onDirectoryChange` hands over each new directory, including the refreshes a
client does while a long transfer runs. `directoryCache()` is the matching
pull, used here only to report which directory a bootstrap ended up on — a seed
this application supplied is never handed back, so nothing rewrites what it
just read.

Reading a seed to apply that rule is webtor-rs's job as well:
`describeDirectory(seed)` answers with the validity window and the time period,
derived by the same code that will place the descriptors. pTransfer holds the
rule and not a second copy of the consensus format, which could otherwise
disagree with the client about where the ring falls.

### Why a cached seed can still be stale

A consensus stays valid for three hours, but a seed is only reused while it
also belongs to the onion-service time period in force now. Where a descriptor
lives is derived from the consensus's own `valid-after`, and the period rotates
on the interval declared by the consensus — daily by default. A seed from
before the rotation can therefore still be valid while describing a ring the
network has stopped using. A service also publishes to whichever adjacent
periods its directory supports, which covers one period of disagreement
between peers; a stale seed spends that slack for nothing, and past it every
HSDir a client tries answers 404 with no hint why. A seed in that state — or
one within ten minutes of expiring — is passed over and the directory
downloaded again, which costs time and never correctness.

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
| `src/lib/tor/transfer.ts` | The size caps and the bridge to the shared transfer layer |
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
# the CLI
cd ../ptransfer-cli && cargo build --release

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
adds a file the previous one did not have. `webtor:released` takes an optional
released version (`bun run webtor:released <version>`) and otherwise uses the
one in webtor-rs's `Cargo.toml`, so switching back after a release lands on it.
