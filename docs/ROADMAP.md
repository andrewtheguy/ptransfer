# Roadmap

## Planned Features

### Answer Return over Nostr Relays (Manual Exchange, phased)

Make Manual Exchange the low-friction default by removing the second manual
hop and, eventually, the manual mode switching. Each phase stands alone and
ships independently; the file-transfer path stays WebRTC unless a phase says
otherwise.

#### Phase 1 — automatic answer return (WebRTC unchanged)

With **Relay file through Nostr** *unchecked* (the normal direct Manual
Exchange flow), the receiver's answer goes back to the sender over Nostr
relays instead of a second QR scan / copy-paste:

- Only the **offer** is still carried by hand (QR or copy/paste). The offer
  payload names the relays the answer will come back on, so both sides agree
  on the channel without a second out-of-band step.
- Reuse the verified-relay logic from the Nostr file relay
  (`src/lib/nostr-file/relay-pool.ts`) in full, minus the storage half: the
  write→read probe of `DEFAULT_RELAYS`, NIP-66/NIP-65 discovery and the
  IndexedDB candidate/health cache to backfill the set when defaults come up
  short, and the same NIP-40 expiration. Answers are small, so the
  control-sized probe (256 B) is the health bar throughout — no full-size
  storage probe, no storage ring, and no background sweep behind a WebRTC
  transfer.
- The answer rides an **encrypted side channel keyed from the offer**, the
  same way the Nostr file relay's control channel is keyed from its code, so
  relays see only ciphertext and the exchange keeps its current security
  boundary (authenticity still rests on the offer's QR/clipboard path).
- **Fallback to manual copy/paste is automatic**: if no relay set passes the
  probe, or the answer does not arrive before a short deadline, the receiver
  shows its answer QR / **Copy Data** exactly as today and the sender shows
  its scan/paste input. The current two-hop flow remains the guaranteed path,
  never a dead end.
- Still WebRTC: file bytes never touch a relay in this phase.

Status: implemented (`src/lib/answer-channel.ts`, wired into
`use-manual-send.ts` / `use-manual-receive.ts`, with the shared
`AnswerReturn` receiver UI). The design as built is documented in
[ARCHITECTURE.md](ARCHITECTURE.md#answer-return-channel-srclibanswer-channelts);
the user-facing flow in [MANUAL_EXCHANGE.md](MANUAL_EXCHANGE.md).

#### Phase 2 — automatic relay fallback for the data path

If the WebRTC connection fails after signaling (the `P2PConnectionError` case
that today just fails with a suggestion), fall back to the Nostr file relay
transport automatically, without the user having to find and check the
experimental **Relay file through Nostr** switch:

- The switch stops being the only way in; it becomes an explicit *prefer
  relay* choice for users who know they have no direct route.
- Fallback inherits the relay transport's constraints (currently ≤ 100 MB,
  1-hour deadline, both pages open) — the UI has to state what it is
  switching to and why, and the sender must still hold the file bytes.
- Needs a decision point after the connection attempt that can hand the
  already-selected files to the relay uploader without a new user action, and
  a receiver side that can be told to stop waiting on the data channel.

#### Phase 3 — Manual Exchange becomes the default

Once Phase 1 removes the second hop and Phase 2 removes the dead end, Manual
Exchange is no harder than Auto Exchange for most users and involves no
signaling server by default:

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
