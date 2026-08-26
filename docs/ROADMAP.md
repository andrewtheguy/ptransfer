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
  use Tor. Splitting it per mode is needed either way; **Anonymous Signaling
  over Onion-Service Nostr Relays** below is where the Tor-side pool comes
  from.
- **Whether both sides must opt in.** Today each device chooses for itself and
  a transfer completes with the option on at one end only, which hides one
  IP address from the relays and not the other, with neither side told what
  the other picked. Requiring agreement (or at least surfacing the mismatch)
  is the open question.

### Anonymous Signaling over Onion-Service Nostr Relays

Anonymous signaling reaches ordinary `wss://` relays through a Tor exit, and the
exit is the part that limits it. Popular relays sit behind Cloudflare or
otherwise refuse exit traffic, which is why `DEFAULT_RELAYS` is two obscure
relays whose only qualification is that they answer. Reaching relays as onion
services instead takes the exit out of the path, and the reputation problem goes
with it: [`0xtrr/onion-service-nostr-relays`](https://github.com/0xtrr/onion-service-nostr-relays)
lists around twenty-five relays exposed as v3 onion services, including onion
mirrors of relays — `nostr.oxtr.dev`, `relay.snort.social` — that will not talk
to an exit on clearnet. One move answers both the pool question and the
reachability question.

Two constraints fall away with it:

- **No exit check.** `check.torproject.org` is consulted today because an exit
  can lie about being one. An onion circuit terminates at the key its address
  commits to, so there is nothing to confirm with a third party.
- **No clearnet TLS.** `subtle-tls` exists to verify a relay certificate inside
  WASM, and its ChaCha20-only, 1.3-only ClientHello follows from SubtleCrypto
  being async. The onion protocol carries its own end-to-end encryption and
  authentication, so `ws://` over an onion circuit needs no TLS layer and the
  constraint lifts for signaling.

The blocker is that no onion client exists in WASM. The vendored Arti crates
carry the primitives — `hs-client` in `tor-proto`, `tor-netdoc` and `tor-cell`,
`hsv3-client` in `tor-llcrypto`, all currently off — but `tor-hsclient` is not
vendored, so the layer it provides has to be written on `tor-proto`: HSDir ring
selection, descriptor fetch and decryption, and the introduce/rendezvous circuit
dance. It is a real protocol project, though a far smaller one than hosting a
service, and **Tor Hidden Service Transport** below needs the same client, so it
is written once.

The relay list is community-maintained by pull request, tracks no uptime, and
makes the onion address its only mandatory column. It is a source of candidates,
not a vetted pool — whatever ships still has to be probed and monitored the way
the current pool should have been.

### Tor Hidden Service Transport

One side hosts a v3 onion service and the other connects to it through Tor. The
bytes still travel between the two peers — Tor carries them, and no third party
stores or forwards them at the application layer — so this is a route around a
hostile NAT rather than a relay someone has to operate and trust.

It covers the cases the Nostr file relay (`docs/NOSTR_FILE_RELAY.md`) does not:
that fallback is Code Exchange only and capped at 100 MiB, which leaves PIN
Exchange, anything over the cap, and every transfer involving the CLI with
nothing but a direct WebRTC connection.

It also collapses signaling for that mode. Because the Tor network is the
rendezvous, the connecting side sends nothing back out-of-band: Code Exchange
needs one payload instead of two, a single one-way code carrying the `.onion`
address and a symmetric key (the pattern beam-rs uses with `generate_tor_code`).

Where it can work:

- **CLI ↔ CLI** works with native Arti today — `arti-client` plus
  `tor-hsservice`, as beam-rs does. `ptransfer-cli` is at v0.0.2 with no Arti
  dependency yet, and it is the natural place to start.
- **CLI ↔ web app** works with the CLI hosting and the web app connecting, once
  the WASM onion client above exists. If the CLI speaks WebSocket on the onion
  address, the browser side is the adapter that already carries signaling, over
  an onion stream instead of an exit stream.
- **Web ↔ web has no hosting side.** `tor-hsservice` is native-only — tokio,
  SQLite, a filesystem — and a browser has no business holding a long-lived
  service identity key across sessions regardless. Web ↔ web keeps WebRTC plus
  the Nostr file relay, and a browser pair that can reach neither stays a
  failed transfer.
- **CLI ↔ an ordinary browser** cannot work at all; browsers do not reach
  `.onion`.

Caveats to design around: the code is shareable only after descriptor upload,
seconds to tens of seconds after launch; a v3 address makes the single code 56+
characters, still fine for QR and copy-paste; and the address alone lets anyone
connect, so the embedded key has to gate authentication and decryption.

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

### TLS 1.2 Fallback for subtle-tls
Retry a failed TLS 1.3 handshake over TLS 1.2 instead of dropping the
connection, so a 1.2-only host is still reachable through Tor. Onion-routed
signaling needs no TLS of its own, which leaves this mattering only to Tor's
own channel TLS and the Snowflake entry path — both of which negotiate 1.3
today.

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
