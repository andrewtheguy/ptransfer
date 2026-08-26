# Anonymous Signaling

Anonymous signaling is an experimental PIN Exchange option. It routes the
device's Nostr relay connections through Tor inside the browser. It does not
route file data through Tor and it does not claim to make the complete transfer
anonymous.

## Current status: proof of concept

Anonymous signaling works end to end, but it is a proof of concept, and it is
labelled experimental wherever it is offered.

**The relay pool is separate, and it is onion services.** Anonymous signaling
never touches `DEFAULT_RELAYS`. It uses `ANONYMOUS_SIGNALING_RELAYS` in
`src/lib/nostr/relays.ts`: Nostr relays reached as v3 onion services
(`ws://<address>.onion`), drawn from
[`0xtrr/onion-service-nostr-relays`](https://github.com/0xtrr/onion-service-nostr-relays)
and kept to the ones that accept writes from a throwaway key — the
sender's kind-4243 rendezvous and both sides' kind-24243 handshakes — and
serve the rendezvous back, checked in webtor-rs
(`docs/onion-relay-probe-2026-08-25.md`). That is a stricter bar than
answering a `REQ`: most onion relays that serve reads refuse anonymous writes
(paid admission, whitelists), and one acknowledges them and drops them. The
list is community-maintained and tracks no uptime, so the pool is a set of
candidates that passed on a given day, not a vetted one; nothing monitors it
yet.
Ordinary PIN Exchange keeps its own clearnet `wss://` pool untouched.

**Both sides must enable it.** The two pools are disjoint and a sender and a
receiver only find each other on a shared relay, so a transfer with the option
on at one end never pairs: the sender waits for a receiver, the receiver
reports that no transfer was found. That is the enforcement — there is no
flag in the protocol for one side to check, and no way for a clearnet socket
on one end to expose the IP address that the other end went through Tor to
hide. The URL validators are the mirror image of each other:
`normalizeRelayUrl` accepts only clearnet `wss://`, `normalizeOnionRelayUrl`
only `ws://` to a v3 onion address, and the Nostr client applies whichever
matches its mode.

Everything below describes the current build.

## Connection path

```text
pTransfer Nostr client
  → WebSocket-compatible TypeScript adapter
  → anonymous-signaling-wasm
  → Snowflake broker + volunteer Snowflake WebRTC proxy
    (or, when the WebSocket bridge box is checked, a direct
     WebSocket to the Snowflake bridge)
  → webtor-rs / Arti circuits
  → onion-service rendezvous (HSDir descriptor, introduction point,
    rendezvous point)
  → ws:// Nostr relay WebSocket on the onion service
```

The existing `nostr-tools` event, subscription, publication, signature, PAKE,
and encryption logic is unchanged. Its pool receives a custom WebSocket
implementation for this mode. The implementation exposes browser-style
`open`, `message`, `error`, and `close` events while its bytes travel over an
onion-service stream.

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

Before the adapter permits any Nostr relay connection, the WASM client proves
itself by fetching the Tor Project's own onion site
(`http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/`)
through a full rendezvous. There is no exit and nothing to ask a third party
about: an onion circuit terminates at the key its address commits to. Failures
before that fetch completes are reported as Tor bootstrap or verification
failures; failures afterward are reported as Nostr relay failures.

The WASM layer accepts only `ws://<address>.onion` relay URLs — `wss://` and
clearnet hosts are refused, since the onion protocol already encrypts and
authenticates the stream end to end — performs the HTTP WebSocket upgrade
inside the onion stream, masks client frames, handles fragmentation and control
frames through tungstenite, and limits a Nostr message to 1 MiB. Each relay
connection is its own rendezvous: a descriptor fetch from an HSDir, a rendezvous
circuit and an introduction circuit, all three hops from the same Snowflake
bridge.

## Privacy boundary

The option hides that device's direct IP address from Nostr relays. There is no
automatic or silent fallback to the browser's direct WebSocket implementation.
If Tor setup or every Tor-routed relay connection fails, PIN Exchange fails.

It does not hide the device's IP address from:

- the host serving the pTransfer application;
- the Snowflake broker, volunteer proxy, and STUN services used for Tor entry;
- the other WebRTC peer once the direct connection is negotiated; or
- the same STUN services used for file-transfer ICE candidate discovery.

Sender and receiver must both enable the option; see *Both sides must enable
it* above.

Nostr events remain end-to-end protected exactly as in ordinary PIN Exchange.
Tor adds transport-level network privacy; it does not replace SPAKE2, event
signatures, encrypted signaling, or content encryption.

## No additional backend

pTransfer remains a static site. The application hosts the generated WASM and
JavaScript glue alongside its other assets. Runtime dependencies are the public
Snowflake broker, volunteer-proxy and bridge infrastructure, the Tor directory
and onion-service infrastructure, and the onion relays; pTransfer does not
operate an anonymous-signaling proxy.

Current directory data is required before webtor can construct a circuit. It
accepts that data from one of three places, in order.

First, the site may serve `/tor-directory.json`: a consensus and the matching
microdescriptors, fetched by `npm run tor:directory` straight from a directory
authority over ordinary HTTP and written into `public/`. Downloading the
directory inside the browser means pulling a multi-megabyte consensus and every
microdescriptor chunk through one Snowflake circuit, one request at a time,
which is the least reliable step of a bootstrap; a served snapshot removes it.

Because that fetch is not circuit-bound, the snapshot carries a microdescriptor
for every relay in the consensus rather than the sample webtor takes for
itself, so path selection is weighted across the whole network. The onion
client needs every relay with the HSDir flag in any case — the HSDir hash ring
is computed from all of them — which is most of the network, so a browser-side
download is several thousand microdescriptors over one Snowflake circuit and
the snapshot matters more than it did for exits. It is about 39 MiB of text,
near 90% of it relay `family` lines, and compresses to roughly 3 MiB on the
wire. The file is not committed and a microdesc consensus
is only valid for three hours, so a deployment that wants the fast path has to
rebuild it at least hourly.

Second, the TypeScript adapter stores the raw consensus and microdescriptors
from the last successful bootstrap as one opaque IndexedDB record, used when no
snapshot is served.

Third, if neither is present or usable, webtor downloads the current compressed
consensus over a one-hop Tor directory stream through the bridge it just
authenticated, followed by microdescriptors for a randomized pool of middle
relays and for every HSDir.

Supplied directory data is never trusted on its face. Rust parses the
consensus, checks its current validity window, matches every microdescriptor
digest back to that consensus, and requires enough usable middle relays and
HSDirs before installing it. An expired, corrupt, oversized, incomplete, or
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
The fork adds a v3 onion-service client to webtor-rs and a dedicated WASM
binding, drops every clearnet path (exits, relay TLS, exit verification), and
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
