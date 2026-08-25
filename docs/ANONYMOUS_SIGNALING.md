# Anonymous Signaling

Anonymous signaling is an experimental PIN Exchange option. It routes the
device's Nostr relay connections through Tor inside the browser. It does not
route file data through Tor and it does not claim to make the complete transfer
anonymous.

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

Immediately after authenticating the Snowflake bridge, webtor downloads the
current compressed consensus over a one-hop Tor directory stream through that
bridge. It then downloads current microdescriptors for randomized pools of
eligible middle and HTTPS-capable exit relays. Current directory data is
required before it constructs a circuit. There is no bundled snapshot, direct
browser directory request, or cross-origin bootstrap dependency.

After a successful bootstrap, the TypeScript adapter stores the raw consensus
and microdescriptors as one opaque IndexedDB record. That record is a fallback,
not a fast path: every start downloads a fresh consensus, and the stored copy is
touched only when that download fails. When it is reached for, Rust re-parses
the consensus, checks its current validity window, matches every microdescriptor
digest back to that consensus, and requires enough usable middle and HTTPS exit
relays before accepting it. An expired, corrupt, oversized, incomplete, or
schema-mismatched entry is rejected — the bootstrap then reports the original
download failure — and any entry is atomically replaced after the next
successful download. Snowflake connections, circuits, streams, and TLS state are
never persisted.

## Source and build

The source-minimized fork and generated WASM package are in the sibling
`../webtor-rs` repository. Its upstream provenance and retained crates are
documented there in `UPSTREAM.md`. pTransfer consumes the generated package
through the local `@andrewtheguy/anonymous-signaling-wasm` file dependency. The
fork adds a raw exit stream to webtor-rs and a dedicated WASM binding. All Web
Crypto keys created or imported by the fork are non-extractable.

With both repositories checked out under the same parent directory, normal
pTransfer validation and builds use the checked-in sibling package directly:

```bash
npm run lint
npx tsc -b
npm run build
```

Rust changes are made and validated in `../webtor-rs`; its `npm run build`
regenerates the checked-in `anonymous-signaling-wasm/pkg/` package before it is
consumed here.
