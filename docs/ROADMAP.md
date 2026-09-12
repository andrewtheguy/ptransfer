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

**Unix only.** The CLI runs on Linux (glibc) and macOS, on x64 and arm64. Windows is out of scope: `cli/main.ts` refuses it, and WSL is Linux.
Every piece is written for a Unix process directly, with no Windows branch and
no portability layer in between:

- **Signals**: SIGINT, SIGTERM and SIGHUP each close the circuits and the
  service and remove a part file, then exit with 128 plus the signal's number,
  as a shell reports it.
- **Files**: a received file is written to a part file beside its
  destination and takes its name with one `rename` — atomic, because both are
  in one directory and so on one file system — after a check that the name is
  still free. `/` is the only path separator, and a
  sender's name is cut to the 255-byte limit of Linux and macOS file names.
- **Cache**: `$XDG_CACHE_HOME/ptransfer`, else `~/.cache/ptransfer`;
  `~/Library/Caches/ptransfer` on macOS.
- **Terminal**: results on standard output, everything else on standard
  error, a password typed in raw mode or piped in, and ANSI escapes.
- **Release targets**: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`
  and `bun-darwin-arm64` — the platforms Bun, OpenTUI and node-datachannel
  all ship prebuilt.

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
   - **2b** (done): `send --tor <path>...` takes several files and folders
     and sends them as one ZIP, built by the tab's own archive code from the
     files found on disk; a lone file still goes as itself. `receive --out
     <folder>` saves into an existing folder instead of the current
     directory.
   - **2c** (done): `--bridge websocket|webrtc` on every Tor command, the
     bridge choices the tab offers. The `webrtc` bridge runs on
     node-datachannel's `RTCPeerConnection`, handed to the Tor client as its
     `rtcPeerConnection` option and loaded only when that bridge is chosen.
3. **Code Exchange and PIN Exchange** over a WebRTC data channel supplied by
   node-datachannel, with the Nostr file relay as the fallback.
   - **3a** (done): `send --code <path>...` prints the offer as text and reads
     the response from standard input; `receive --code` reads the offer and
     prints the response, and `--simulate-no-direct` stands in for the tab's
     switch of that name. Codes are carried as text, since a terminal has no
     camera, and are the same text the tab copies and pastes, so either end can
     be a tab. Both fallbacks run: the Nostr file relay, with the relay cache in
     `relay-cache.json` — changed under an `flock` on `relay-cache.lock`, as
     the Rust CLI did, so concurrent senders keep each other's verdicts — and
     with `--anonymous` the Tor one. The engine in
     `src/lib/code-exchange` takes what differs per host as an `ExchangeHost`.
   - **3b**: PIN Exchange, which carries the same codes over its sealed Nostr
     channel.
4. **An OpenTUI terminal UI** — `@opentui/core` with its React bindings,
   `@opentui/react`, so the screens are React like the tab's — and one binary
   per release target from `bun build --compile`.
   - **4a** (done): the screens, on the same engine the line interface runs.
     `ptransfer` with nothing after it opens it; every command keeps the
     line-oriented interface of phases 2 and 3 exactly as it was, which is
     what a pipe, a script and every live test drive, and a terminal UI asked
     for without a terminal is a usage error rather than a half-drawn screen.
     - What a transfer shows and asks for goes through one `Presenter`
       (`cli/ui/presenter.ts`): standard error and standard input on the line
       (`cli/ui/line.ts`), or the screen (`cli/tui/presenter.ts`). The
       transfer code itself knows neither, which is what lets the two hosts
       run the same flows.
     - The send side mirrors the tab's send tab: a path picker that marks
       files and folders, then the tab's three modes in the tab's order —
       PIN Exchange, Code Exchange, Tor Onion Service — with the cursor on
       Code Exchange, and the tab's two advanced options behind them (the
       anonymous fallback, and the Tor bridge). The receive side mirrors the
       tab's receive screen: one field, and the mode read off what is pasted
       with the tab's own `classifyReceiveText`, with the same Tor bridge
       behind it, and then the folder picker — always asked, and asked once
       the code is in, since until then there is nothing to save. The folder
       is checked where it is chosen, as `--out` is before the bootstrap.
     - PIN Exchange is listed on both sides and says it is not here yet;
       phase 3b is what fills it in. A QR chunk is the one input with no
       answer here, since a terminal has no camera to have scanned one with.
     - A Code Exchange code is thousands of characters, so it is shown in a
       box that scrolls, with `c` copying it through OSC 52; a terminal that
       will not take a clipboard copy says so and leaves the box to select
       from. A field on screen takes every printable key it is sent, so the
       screens that have one put their keys where a field leaves them: tab
       copies beside a field, and the receive screen's bridge is tab.
   - **4b**: one binary per release target from `bun build --compile`.
   - OpenTUI draws through a native Zig core it loads over FFI, from a
     prebuilt package per target (`@opentui/core-<os>-<arch>`). It needs Bun,
     or Node 26.4 or later; the vitest unit project runs on an older Node, so
     terminal UI components are tested under `bun test` with OpenTUI's
     `testRender` — `bun run test:tui`, over `*.tui.test.tsx`, which the
     vitest run excludes — and the vitest-tested modules stay free of it.
   - The build is a `Bun.build` script, one run per target, that defines
     `process.env.OPENTUI_LIBC` as `glibc` for the Linux targets and carries
     the node-datachannel plugin described below. Cross-building needs every
     target's native packages installed on the build machine
     (`bun install --os=<os> --cpu=<cpu>`), or one build per target in CI.

Why a JavaScript CLI is viable at all, checked under Bun 1.4 so the later
phases rest on something measured rather than assumed — the first two before
phase 1 was built, the last two after phase 2a:

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
- OpenTUI 0.5 with `@opentui/react` renders under Bun 1.4, and a
  `bun build --compile` binary embeds its native core: the binary drew the
  same frame with no `node_modules` anywhere near it.
- node-datachannel 0.33 embeds too, with help. It chooses its addon package by
  a name computed at run time, which the bundler cannot follow, so a compiled
  binary fails with "Cannot load native addon". A build plugin that replaces
  that lookup with a static import of the target's `node_datachannel.node`
  gets it embedded, and the binary then opened a data channel over loopback
  with no `node_modules` present.

Open items, in no particular order:

- `cli/tor/directory-fetch.ts` is a copy of webtor-rs's
  `tests/tools/fetch-directory.ts`. It belongs in the webtor npm package, which
  pTransfer is the only live customer of, so the two do not drift.
- The fetcher reads from the directory authorities directly. Public directory
  mirrors (fallback directories) should be preferred, with the authorities as
  the last resort, so a fleet of CLIs does not load the nine authorities.
- The node-datachannel build plugin rewrites the package's own loader, so it
  breaks when a release changes that loader. A static per-target entry point
  in node-datachannel itself would make the plugin unnecessary.

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
