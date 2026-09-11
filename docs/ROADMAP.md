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
- Documentation reversal: `README.md` and `docs/ARCHITECTURE.md` currently
  describe Nostr signaling as the default; both need rewriting, plus a version
  bump for the behavior change.

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

### The CLI in `cli/`
A command-line host for the same `src/lib` code the browser tab runs, so a
change to the web app is a change to the CLI by construction. It replaces the
retired Rust `ptransfer-cli`, which reimplemented every wire format separately.

1. **Project restructure and `tor-test`** (done): the `cli/` directory, a
   Bun-hosted loader for the same webtor-wasm Tor client, a directory
   download over plain HTTP from the authorities with a disk cache, and a
   `bun run cli tor-test` self-check that bootstraps, fetches a page from a
   public onion service, publishes an onion service, and connects back to it.
2. **Tor send and receive** from the terminal over `src/lib/tor`.
   - **2a** (done): `send --tor <file>` publishes an onion service for one
     file and prints its address and password; `receive --onion <address>`
     reads the password from standard input and saves the file in the current
     directory under the sender's name, never overwriting.
   - **2b**: folders sent as a ZIP, a choice of where the file lands, and the
     bridge choices the tab offers.
3. **PIN Exchange and Code Exchange** over a WebRTC data channel supplied by
   node-datachannel, with the Nostr file relay as the fallback; codes are
   carried as text, since a terminal has no camera.
4. **An Ink terminal UI**, and a single-binary build with `bun build --compile`
   — whether the native WebRTC addon can be embedded in that binary is the
   open question.

Why a JavaScript CLI is viable at all, checked under Bun 1.4 before phase 1
was built, so the later phases rest on something measured rather than assumed:

- The slow browser bootstrap is a browser limitation, not a Tor one: a tab
  cannot fetch the directory over plain HTTP, a process can. Plain HTTP to the
  directory authorities' DirPorts, four requests in flight, assembles a ~38 MiB
  seed in about 25 s; with that seed the unmodified webtor-wasm binary is
  bootstrapped over the public websocket Snowflake bridge in about 3.5 s. A
  cold `tor-test` runs in about 35 s end to end and a warm one, with the seed
  cached on disk, in about 12–15 s. Performance is not a goal, which is why
  Snowflake over websocket is acceptable and a native Arti stack is not on the
  table.
- `node-datachannel/polyfill` gives a working `RTCPeerConnection` under Bun,
  so PIN Exchange and Code Exchange have a transport for phase 3.
- Ink 7 with `@inkjs/ui` renders under Bun, so phase 4's terminal UI is React
  in the stack the web app already uses.

Open items, in no particular order:

- `cli/tor/directory-fetch.ts` is a copy of webtor-rs's
  `tests/tools/fetch-directory.ts`. It belongs in the webtor npm package, which
  pTransfer is the only live customer of, so the two do not drift.
- The fetcher reads from the directory authorities directly. Public directory
  mirrors (fallback directories) should be preferred, with the authorities as
  the last resort, so a fleet of CLIs does not load the nine authorities.
- `bun build --compile` with the `node-datachannel` N-API addon is untested;
  if it cannot embed the addon, phase 4 ships a Bun script plus a lockfile
  instead of one binary.

## Backlog (Future Considerations)

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
  works from any origin with no proxy. Works browser ↔ browser, and the CLI
  would run the same code over plain HTTP.
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
- **CLI support**: the CLI in `cli/` runs the same `src/lib` code, so it will
  carry whatever fallbacks the web app carries, this one included once it
  exists.
- Alternatives considered: a self-hosted Magic Wormhole transit relay
  (WebSocket-capable upstream, blind token-matching pipe, but requires running
  a server); or a TURN server (least protocol work since transport is already
  WebRTC, same trust profile).

### Other
- Better website UI/UX
