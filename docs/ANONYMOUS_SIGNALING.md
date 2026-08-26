# Anonymous Signaling

Anonymous signaling is an experimental PIN Exchange option. It routes the
device's Nostr relay connections through Tor inside the browser. It does not
route file data through Tor and it does not claim to make the complete transfer
anonymous.

## Current status: proof of concept

Anonymous signaling works end to end, but it is a proof of concept, and it is
labelled experimental wherever it is offered. Two properties of the current
build are artifacts of that stage rather than settled design, and both are
expected to change before it is presented as a finished feature.

**The relay pool is two relays picked off a public list.** `DEFAULT_RELAYS` in
`src/lib/nostr/relays.ts` is `wss://relay.pocketnostr.com` and
`wss://nostrelay.circum.space`, chosen because the popular relays (damus,
nos.lol, primal, snort) sit behind Cloudflare or otherwise refuse traffic from
Tor exits. Neither has been vetted for uptime, capacity, or how long it will
keep accepting exit-node connections, and nothing monitors whether they still
do. That list is also the pool for ordinary PIN Exchange — one constant serves
both modes — so Tor reachability currently narrows the relay set for transfers
that never touch Tor. Going live means a vetted pool, and probably a
Tor-specific list instead of one shared one.

**Each device chooses on its own, and one side is enough.** Nothing requires
the sender and the receiver to both enable it. A transfer where only one side
does completes normally: that device's IP address is hidden from the relays and
the other device's is not, and neither device is told what the other chose.
Whether the two sides should have to agree before the transfer proceeds is
open.

Everything below describes the current build.

## Connection path

```text
pTransfer Nostr client
  → WebSocket-compatible TypeScript adapter
  → anonymous-signaling-wasm
  → Snowflake broker + volunteer Snowflake WebRTC proxy
    (or, when the WebSocket bridge box is checked, a direct
     WebSocket to the Snowflake bridge)
  → webtor-rs / Arti circuit
  → Tor exit
  → Tor Check exit verification
  → verified TLS 1.3
  → public Nostr relay WebSocket
```

The existing `nostr-tools` event, subscription, publication, signature, PAKE,
and encryption logic is unchanged. Its pool receives a custom WebSocket
implementation for this mode. The implementation exposes browser-style
`open`, `message`, `error`, and `close` events while its bytes travel over a
Tor exit stream.

The default entry transport is standard Snowflake WebRTC: the browser sends an
SDP offer to the public Snowflake broker, connects to the assigned volunteer
proxy, and carries Tor link traffic over that DataChannel. It uses the same
canonical Google and Cloudflare STUN URL list as pTransfer's file-transfer
WebRTC, passed from TypeScript into WASM rather than maintained as a second Rust
list. These are separate peer connections even though their STUN configuration
is shared.

Enabling Anonymous signaling reveals a second checkbox that switches the entry
transport to the direct browser Snowflake WebSocket path instead. That path
dials `wss://snowflake.torproject.net/` itself, so it uses no broker, no
volunteer proxy, and no STUN, and it frequently starts faster. In exchange it
always contacts one fixed Tor Project address, which is correspondingly easier
to block, and no volunteer proxy stands between the client and the bridge. The
choice is explicit per transfer on each device; neither transport is an
automatic fallback for the other.

Before the adapter permits any Nostr relay connection, the WASM client makes
a raw HTTPS request through Tor to `https://check.torproject.org/api/ip` and
requires an `IsTor: true` response. This is exit-side HTTP inside WASM, not a
browser `fetch`, so CORS does not apply. Failures before that check completes
are reported as Tor bootstrap or verification failures; failures afterward are
reported as Nostr relay failures.

The WASM layer accepts only `wss://` relay URLs, verifies the relay certificate,
performs the HTTP WebSocket upgrade inside the Tor stream, masks client frames,
handles fragmentation and control frames through tungstenite, and limits a
Nostr message to 1 MiB. Relay streams in one signaling session share the Tor
circuit that passed exit verification.

## Privacy boundary

The option hides that device's direct IP address from Nostr relays. There is no
automatic or silent fallback to the browser's direct WebSocket implementation.
If Tor setup or every Tor-routed relay connection fails, PIN Exchange fails.

It does not hide the device's IP address from:

- the host serving the pTransfer application;
- the Snowflake broker, volunteer proxy, and STUN services used for Tor entry;
- the other WebRTC peer once the direct connection is negotiated; or
- the same STUN services used for file-transfer ICE candidate discovery.

Sender and receiver choose the option independently. Enabling it protects only
that participant's Nostr connections, so both participants should enable it if
both want their direct IP hidden from the relays.

Nostr events remain end-to-end protected exactly as in ordinary PIN Exchange.
Tor adds transport-level network privacy; it does not replace SPAKE2, event
signatures, encrypted signaling, or content encryption.

## No additional backend

pTransfer remains a static site. The application hosts the generated WASM and
JavaScript glue alongside its other assets. Runtime dependencies are the public
Snowflake broker, volunteer-proxy and bridge infrastructure, the Tor Project's
exit-check API, and public Nostr relays; pTransfer does not operate an
anonymous-signaling proxy.

Current directory data is required before webtor can construct a circuit. It
accepts that data from one of three places, in order.

First, the site may serve `/tor-directory.json`: a consensus and the matching
microdescriptors, fetched by `npm run tor:directory` straight from a directory
authority over ordinary HTTP and written into `public/`. Downloading the
directory inside the browser means pulling a multi-megabyte consensus and every
microdescriptor chunk through one Snowflake circuit, one request at a time,
which is the least reliable step of a bootstrap; a served snapshot removes it.

Because that fetch is not circuit-bound, the snapshot carries a microdescriptor
for every relay in the consensus rather than the small per-role sample webtor
takes for itself, so path selection is weighted across the whole network. It is
about 39 MiB of text, near 90% of it relay `family` lines, and compresses to
roughly 3 MiB on the wire. The file is not committed and a microdesc consensus
is only valid for three hours, so a deployment that wants the fast path has to
rebuild it at least hourly.

Second, the TypeScript adapter stores the raw consensus and microdescriptors
from the last successful bootstrap as one opaque IndexedDB record, used when no
snapshot is served.

Third, if neither is present or usable, webtor downloads the current compressed
consensus over a one-hop Tor directory stream through the bridge it just
authenticated, followed by microdescriptors for randomized pools of eligible
middle and HTTPS-capable exit relays.

Supplied directory data is never trusted on its face. Rust parses the
consensus, checks its current validity window, matches every microdescriptor
digest back to that consensus, and requires enough usable middle and HTTPS exit
relays before installing it. An expired, corrupt, oversized, incomplete, or
schema-mismatched document is rejected and the bootstrap falls through to
downloading the directory itself. The IndexedDB record is atomically replaced
after each successful bootstrap. Snowflake connections, circuits, streams, and
TLS state are never persisted.

The snapshot is not signature-checked, and neither is a downloaded consensus:
webtor verifies timeliness and internal consistency, not the directory
authorities' signatures. Serving a snapshot therefore lets the site choose
which relays a visitor's circuit is built from, which a browser-side download
leaves to the bridge instead.

## Source and build

The source-minimized fork that generates the WASM package lives in the
[`webtor-rs`](https://github.com/andrewtheguy/webtor-rs) repository; its
upstream provenance and retained crates are documented there in `UPSTREAM.md`.
The fork adds a raw exit stream to webtor-rs and a dedicated WASM binding, and
all Web Crypto keys it creates or imports are non-extractable.

pTransfer installs the generated package as a `.tgz` asset published on a
webtor-rs GitHub release, the same way it installs the QR WASM packages:

```json
"@andrewtheguy/anonymous-signaling-wasm": "https://github.com/andrewtheguy/webtor-rs/releases/download/v0.0.1-alpha.1/andrewtheguy-anonymous-signaling-wasm-0.0.1-alpha.1.tgz"
```

The `0.0.1-alpha` line is deliberate: the package is versioned as the proof of
concept it is, and it is a GitHub pre-release. `npm install` therefore needs no
sibling checkout, and normal validation and builds are the usual:

```bash
npm run lint
npx tsc -b
npm run build
```

### Developing against a local webtor-rs build

To run against an unreleased build, check `webtor-rs` out next to this
repository, run its `npm run build`, and swap the installed package for the
generated `anonymous-signaling-wasm/pkg/` directory:

```bash
npm run wasm:local      # install the sibling build into node_modules
npm run wasm:released   # restore the released .tgz
```

`wasm:local` writes neither `package.json` nor `package-lock.json`, so the
override lives only in `node_modules` and cannot be committed by accident;
`wasm:released` is a plain `npm ci`. Rust changes are made and validated in
`webtor-rs`, and reach pTransfer for real only through a new release.
