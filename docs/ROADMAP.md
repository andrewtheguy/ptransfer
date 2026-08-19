# Roadmap

## Planned Features

### NIP-65/NIP-66 Relay Discovery
Implement automatic relay discovery using Nostr relay list events:
- Query seed relays for relay list events (kind 10002 NIP-65, kind 30166 NIP-66)
- Probe discovered relays for latency and capabilities
- Cache discovered relays in sessionStorage with TTL
- Select best relays based on latency, availability, and suitability
- Filter out relays requiring payment or authentication

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
- **Requires secure-send-cli on the hosting side** (native Rust can use
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

### Other
- Better website UI/UX
