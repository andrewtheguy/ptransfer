# Roadmap

## Planned Features

### Code Exchange becomes the default

Now that the Nostr relay fallback (see `docs/NOSTR_FILE_RELAY.md`) removes
many direct-connection dead ends, Code Exchange may be practical as the
initial mode while keeping its fully hand-carried signaling path:

- Flip the Transfer mode default: Code Exchange is selected on the send tab out
  of the box. The receive tab no longer has a mode selector — it infers the
  mode from what the receiver pastes or scans — so there is nothing to flip
  there.
- **PIN Exchange becomes the accessibility path** — the choice for people who
  cannot copy/paste or scan (in-app browsers with a blocked clipboard, no
  camera, screen-reader or motor-accessibility constraints, device pairs where
  moving a QR is impractical). It stays fully supported and one click away. The
  UI copy already offers it in those terms.
- Documentation reversal: `docs/CODE_EXCHANGE.md` and `docs/ARCHITECTURE.md`
  currently describe Nostr signaling as the default; both need rewriting, plus
  a version bump for the behavior change.

### Take Anonymous Signaling Out of Proof-of-Concept

Anonymous signaling works, but two parts of it are placeholders (see
`docs/ANONYMOUS_SIGNALING.md`) that have to be settled before it stops being
labelled experimental:

- **A vetted relay pool.** `DEFAULT_RELAYS` is currently two relays picked off
  a public list because they accept Tor exit traffic, with no uptime, capacity
  or longevity evidence behind either. The same constant also serves ordinary
  PIN Exchange, so Tor reachability narrows the pool for transfers that never
  use Tor — a Tor-specific list, or a per-mode pool, is probably the answer.
- **Whether both sides must opt in.** Today each device chooses for itself and
  a transfer completes with the option on at one end only, which hides one
  IP address from the relays and not the other, with neither side told what
  the other picked. Requiring agreement (or at least surfacing the mismatch)
  is the open question.

### More Efficient Use of the Relay Cache in Code Exchange
Make Code Exchange lean harder on the IndexedDB relay cache
(`src/lib/nostr-file/relay-pool.ts`) so that relays already proven in a
recent session are trusted first and probed less, cutting the time spent
proving control relays before the offer QR and preparing the storage ring
behind it. Concretely:
- Skip or defer re-probing relays that passed recently, instead of probing
  every candidate again on each exchange.
- Skip the in-depth background sweep (the uncapped enumeration of the whole
  relay population, beyond ~200 candidates) when one was completed recently,
  rather than re-enumerating and re-probing everything behind every exchange.

### Custom Relay Configuration
Allow users to specify their own preferred Nostr relays for signaling.

## Backlog (Future Considerations)

### Tor Hidden Service Transport (Single-Exchange Code Mode)
A transfer mode where one side hosts a Tor onion service and the other connects
to it through Tor, replacing the WebRTC offer/answer round trip with a single
one-way code: the `.onion` address plus a symmetric key (the pattern beam-rs
uses with `generate_tor_code`). Because the Tor network itself is the
rendezvous, the connecting side sends nothing back out-of-band, so Code
Exchange needs only one payload instead of two.

Findings from research (August 2026):
- **Not implementable in the browser today.** webtor-rs proves Arti's
  `tor-proto` runs in WASM over Snowflake, but neither upstream webtor-rs nor
  the pTransfer fork has any onion service support (client or hosting), and
  upstream exposes only HTTP fetch, no raw streams. (The pTransfer fork does
  add raw exit streams — `TorClient::open_stream`, what the anonymous
  signaling WebSocket rides on — but those are exit streams, not the
  onion-service circuits this feature needs.) Arti's
  `arti-client`/`tor-hsservice` stack is native-only (tokio, SQLite,
  filesystem). A browser-hosted onion service is architecturally
  possible (hosting uses only outbound circuits) but would mean reimplementing
  `tor-hsservice`/`tor-hsclient` on top of `tor-proto` in WASM — a major
  security-sensitive protocol project no one has done.
- **Requires ptransfer-cli on the hosting side** (native Rust can use
  `arti-client` + `tor-hsservice` like beam-rs). CLI ↔ CLI works directly.
- **CLI ↔ regular browser does not work** — browsers cannot reach `.onion`.
- **CLI ↔ web app in Tor Browser is possible** but requires a new
  WebSocket-over-onion transport in the web app, since Tor Browser disables
  WebRTC (Tor carries TCP streams, not ICE/UDP; `.onion` origins are treated
  as secure contexts so `ws://<addr>.onion` works from the page).
- Caveats: the code is only shareable after descriptor upload (seconds to tens
  of seconds after launch), and a v3 onion address makes the single code ~56+
  characters — still fine for QR/copy-paste. The onion address alone lets
  anyone connect, so the embedded key must gate decryption/authentication.

### Relay Fallback for Data Transfer via ppng.io (piping-server)
A fallback path for when WebRTC finds no direct route: stream the encrypted
payload through a public HTTP relay instead of failing. piping-server
(https://ppng.io) is a blind streaming relay — the sender `POST`s to a path,
the receiver `GET`s the same path, and bytes stream through without being
stored.

Findings from research (August 2026):
- **CORS is fully open** (verified live against ppng.io): preflight returns
  `access-control-allow-origin: *` with `GET, HEAD, POST, PUT, OPTIONS` and
  headers `Content-Type, Content-Disposition, X-Piping`, so browser `fetch()`
  works from any origin with no proxy. Works browser ↔ browser and
  browser ↔ CLI (plain HTTP on both sides).
- **Rendezvous fits the existing PAKE**: derive a high-entropy path from the
  SPAKE2 shared secret (HKDF); the path is the only thing gating the stream,
  and the payload is E2E-encrypted before it touches the relay, so the relay
  sees only ciphertext and both parties' IPs — the same trust position the
  Nostr signaling relays already occupy.
- **Zero infrastructure**: unlike adapting Magic Wormhole's transit relay
  (whose public instances are donated app-specific infra — the default
  `transit.magic-wormhole.io` is raw TCP a browser can't reach, and Least
  Authority's WebSocket relay is for Winden), ppng.io is explicitly offered as
  general-purpose public piping infrastructure. It is also self-hostable if
  its goodwill or bandwidth tolerance for multi-GB transfers proves
  insufficient — there is no SLA.
- **Design tension**: the CLI's transport is deliberately direct-only ("fails
  rather than route file bytes through a relay server"). A relay fallback
  reverses that stance and should be opt-in, ideally with a user-configurable
  relay URL.
- Alternatives considered: a self-hosted Magic Wormhole transit relay
  (WebSocket-capable upstream, blind token-matching pipe, but requires running
  a server); a TURN server (least protocol work since transport is already
  WebRTC, same trust profile); iroh's relay network (browser support in alpha
  as of iroh 0.32, always-relayed via WebSocket in browsers, would also give
  CLI interop since beam-rs uses iroh natively).

### TLS 1.2 Fallback for subtle-tls
Retry a failed TLS 1.3 handshake over TLS 1.2 instead of dropping the
connection, so a 1.2-only host is still reachable through Tor.

Findings (August 2026):
- **The code is compiled in but unreachable.** Restoring the full `subtle-tls`
  crate brought back `handshake_1_2.rs`, `record_1_2.rs`, `stream_1_2.rs` and
  `prf.rs`, and `tls12` is a default feature, so `TlsVersion::{Tls12,
  Prefer13}`, `TlsConnector::connect_versioned` and `connect_tls12` all build.
  Nothing calls them: every TLS call site (`webtor/src/http.rs`,
  `snowflake_webrtc.rs`, `snowflake_ws.rs`, `anonymous-signaling-wasm`) pins
  `TlsVersion::Tls13`.
- **`Prefer13` is not a fallback.** A failed handshake consumes the stream, so
  it only tries 1.3 and reports the error (`subtle-tls/src/lib.rs`). A real
  fallback has to open a *fresh Tor stream* and retry with `Tls12`, which means
  the retry lives in the caller, not the connector.
- **Blocker 1 — no poll-based stream.** `TlsStream12` exposes only inherent
  `async fn read`/`write`; it does not implement `futures::io::AsyncRead`/
  `AsyncWrite` the way `TlsStream` does. Every consumer here is generic over
  those traits, so the poll impls have to be written first.
- **Blocker 2 — the sync AEAD constraint returns.** `poll_read`/`poll_write`
  cannot await, and the 1.2 record layer has no synchronous path at all. Its
  six offered suites are AES-GCM and AES-CBC through SubtleCrypto, which is
  async; TLS 1.2's ChaCha20-Poly1305 suites (0xCCA8/0xCCA9) are not
  implemented. This is the same constraint that forced the ChaCha20-only
  ClientHello for 1.3, and it would have to be solved again for 1.2.
- **`export_keying_material` is unimplemented for 1.2**, so the fallback could
  not carry Tor's own channel TLS even if the stream traits existed.
- **Value is unproven.** Every host reached today negotiates 1.3 — the Nostr
  relays, the Snowflake broker and bridge, `curl.se`, `check.torproject.org`.
  Pinning 1.3 also removes downgrade risk, so this is worth doing only if a
  host that matters turns out to be 1.2-only.

### Other
- Better website UI/UX
