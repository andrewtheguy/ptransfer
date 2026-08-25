# Roadmap

## Planned Features

### Nostr Relays behind Manual Exchange (phased)

Make Manual Exchange a lower-friction option by removing direct-connection
dead ends and, eventually, reversing the initial mode selection. Each phase
stands alone and ships independently.

#### Phase 1 — proven relays named in the offer (WebRTC unchanged)

While the Manual Exchange offer is built, the sender proves a small set of
relays and names them in the offer, so a later phase has a ready control
channel the moment signaling completes:

- Both the **offer** and the **answer** are always carried by hand (QR or
  copy/paste). The answer enters the sender's page only through the sender's
  own scan or paste — relays never carry signaling in this mode, so no
  bystander who captures the offer can push a response into the sender's page.
  (An earlier revision let the receiver publish the answer to the offer's
  relays instead; that path was removed as a security and UX regression.)
- Reuse the verified-relay logic from the Nostr file relay
  (`resolveTransferRelays`) in full: the control-sized write→read probe of
  `DEFAULT_RELAYS`, and — when defaults come up short — the same NIP-66/NIP-65
  discovery and full-size probe the storage transfer runs, stopped as soon as
  the gap is filled, so a defunct default is made up from a full-size-proven
  discovered relay rather than a weaker control-sized discovery. Only the
  control-relay resolution is awaited before the QR (the offer must name the
  relays); the storage ring and its background sweep are prepared behind the
  exchange as relay preparation for Phase 2 (the QR does not depend on them),
  never touching the file.
- If no relay set passes the probe, the offer names none and Phase 2 is
  unavailable for that transfer.
- Still WebRTC: file bytes never touch a relay in this phase.

Status: implemented (`resolveTransferRelays` wired into `use-manual-send.ts`,
the `relays` field of the offer in `src/lib/manual-signaling.ts`).

#### Phase 2 — automatic relay fallback for the data path

When the WebRTC connection cannot be established after signaling (the
`P2PConnectionError` case that used to just fail with a suggestion), the file
falls back to the Nostr relay transport automatically — the Nostr relay
transport becomes the Manual Exchange stand-in for TURN, with no user opt-in.

- The old opt-in **Relay file through Nostr** toggle is gone, and so is the
  standalone `nostr-file-live` code payload. Nothing is uploaded ahead of
  time: the relay engine runs only after a direct connection fails, so a
  transfer that would have connected directly never touches a storage relay.
- Both sides derive the relay session (transfer id + file key) from the
  Manual Exchange ECDH shared secret (`deriveRelaySession`, HKDF), so no key
  or id ever rides in a code. The control channel rides the proven relays the
  offer already named, so the session is ready the moment signaling
  completes.
- The sender sends the file manifest as the first control-channel message
  (it used to travel in the code), adopts the storage ring that was already
  being prepared behind the exchange, and uploads a single copy per piece
  exactly as before; the receiver, seeing its direct
  connection fail, joins the same channel and pulls the pieces.
- What matters is only whether the **offer named proven relays**: both sides
  then share the offer's relays and the derived session. Those relays carry
  the fallback's encrypted control channel; a separate discovered storage
  ring carries the file pieces.
- The fallback is unavailable when the offer named no relays (fewer than
  `MIN_CONTROL_RELAYS` were proven when it was built) or the file exceeds the
  100 MiB cap. It can also fail later if too few storage relays work or pieces
  cannot be delivered.

Status: implemented. Sender/receiver fallback lives in
`use-manual-send.ts` / `use-manual-receive.ts`; the session derivation in
`src/lib/nostr-file/session.ts`; the manifest-over-control-channel change in
`src/lib/nostr-file/control.ts` / `upload-live.ts` / `download-live.ts`.

#### Phase 3 — Manual Exchange becomes the default

Once Phase 2 removes many direct connection dead ends, Manual Exchange may be
practical as the initial mode while keeping its fully hand-carried signaling
path:

- Flip the Transfer mode default: Manual Exchange is selected on the send and
  receive tabs out of the box.
- **Auto Exchange becomes the accessibility path** — the choice for people who
  cannot copy/paste or scan (in-app browsers with a blocked clipboard, no
  camera, screen-reader or motor-accessibility constraints, device pairs where
  moving a QR is impractical). It stays fully supported and one click away,
  with UI copy that offers it in those terms rather than as "the automatic
  mode".
- Documentation reversal: `docs/MANUAL_EXCHANGE.md` and `docs/ARCHITECTURE.md`
  currently describe Nostr signaling as the default; both need rewriting, plus
  a version bump for the behavior change.

### NIP-65/NIP-66 Relay Discovery
Implement automatic relay discovery using Nostr relay list events:
- Query seed relays for relay list events (kind 10002 NIP-65, kind 30166 NIP-66)
- Probe discovered relays for latency and capabilities
- Cache discovered and health-proven relays in IndexedDB with TTL
- Select best relays based on latency, availability, and suitability
- Filter out relays requiring payment or authentication

Status: implemented for the experimental Nostr file relay
(`src/lib/nostr-file/relay-pool.ts` — NIP-66/NIP-65 discovery, write→read
health probes, canonical-keyed IndexedDB relay-health metadata with a 24h TTL,
and rotating batch selection). Not yet used for Auto Exchange signaling
relays.

### Custom Relay Configuration
Allow users to specify their own preferred Nostr relays for signaling.

## Backlog (Future Considerations)

### Tor Hidden Service Transport (Single-Exchange Manual Mode)
A transfer mode where one side hosts a Tor onion service and the other connects
to it through Tor, replacing the WebRTC offer/answer round trip with a single
one-way code: the `.onion` address plus a symmetric key (the pattern beam-rs
uses with `generate_tor_code`). Because the Tor network itself is the
rendezvous, the connecting side sends nothing back out-of-band, so manual
exchange needs only one payload instead of two.

Findings from research (August 2026):
- **Not implementable in the browser today.** webtor-rs proves Arti's
  `tor-proto` runs in WASM over Snowflake/WebTunnel, but it has no onion
  service support (client or hosting) and exposes only HTTP fetch, no raw
  streams. Arti's `arti-client`/`tor-hsservice` stack is native-only (tokio,
  SQLite, filesystem). A browser-hosted onion service is architecturally
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

### Other
- Better website UI/UX
