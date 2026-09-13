# Agent instructions

## Compatibility and versioning

- Strict no backward compatibility or legacy code path under any circumstances;
  bump a version to signal a breaking change instead. There are two numbers,
  and they move independently; the web app has no number at all.
- `PROTOCOL_VERSION` in `src/lib/protocol-version.ts` is the compatibility
  version: two peers interoperate exactly when it matches. Bump it by one
  whenever what goes on the wire changes (anything the protocol documents in
  `docs/` specify), only once per branch, and never for anything else.
- The `package.json` version, exported as `CLI_VERSION` in `cli/version.ts`,
  is the CLI's release version and says nothing about compatibility. It is what
  the `Release CLI` workflow, run by hand, publishes binaries under and tags
  `v<version>`, so releasing the same version twice is refused. Bump it by patch only, once per
  branch, whenever a CLI user or a script can see the change — a flag or an
  environment variable, added or altered; what a command prints; what a
  terminal UI screen shows; stored data such as a cache format — whether or
  not it breaks anything. A wire change alone does not bump it, and a change
  only the tab sees never does. A release may bump it with no change of
  either kind.
- The web app has no release version: it is deployed straight from a commit, so
  the commit is its identity — `GIT_COMMIT_HASH` in `src/lib/build-commit.ts`,
  from the deploy's environment, shown in the footer beside the protocol
  version. Never give it a number of its own.
- Bump `TOR_HANDSHAKE_VERSION` in `src/lib/tor/handshake.ts` whenever the Tor
  handshake frames specified in `docs/TOR_TRANSPORT.md` change, together with
  `PROTOCOL_VERSION`, and leave it alone otherwise; it travels on the wire and
  is refused on a mismatch. The only other version sent on the wire is
  `PROTOCOL_VERSION` itself, in the PIN Exchange rendezvous and claim, where a
  mismatch is refused too.

## Layout

- `src/` is the web app; `src/lib` is the protocol and transport code both
  hosts run.
- `cli/` is the Bun command-line app. It imports `src/lib` directly through
  the `@/` alias and may only import modules that touch no browser API: no
  `import.meta.env`, no Vite `?url` or `?raw` imports, no DOM. A piece that
  differs per host gets one file per host — for the Tor client that is
  `src/lib/tor/webtor.ts` in the browser and `cli/tor/webtor.ts` under Bun,
  both typed by `src/lib/tor/webtor-api.ts`; the rule they share, such as the
  directory freshness rule in `src/lib/tor/directory-policy.ts`, stays in
  `src/lib` with no platform API in it.
- `cli/` is Unix only: Linux and macOS, never Windows. Use what a Unix process
  has — signals, atomic rename, the XDG directories, `/` as the only separator —
  directly, with no Windows branch. Its terminal UI is OpenTUI with the React
  bindings, in `cli/tui`, and `ptransfer` with no command opens it; every
  command stays line-oriented, which is what pipes, scripts and the live tests
  drive. What a transfer shows and asks for goes through the `Presenter` in
  `cli/ui/presenter.ts`, so neither host's plumbing reaches the transfer code.
  The scope and the release targets are in `docs/ROADMAP.md`.

## Checks to run

- Always run `bun run lint` and then `bunx tsc -b` for any javascript changes to
  check and fix any issues after javascript related changes before committing
  code. `tsc -b` type-checks `cli/` through `tsconfig.cli.json`, with no DOM
  library, which is what keeps browser-only code out of it.
- This repo has slow opt in tests, don't run `bun test` directly on normal flow
  when those opt in tests are not expected to run.
- `bun run test:tui` renders the terminal UI's screens under `bun test` with
  OpenTUI's `testRender`. Run it after changing `cli/tui/`. Those files are
  `*.tui.test.tsx` and the vitest run excludes them: OpenTUI loads a native
  core over FFI and needs Bun or Node 26.4, which vitest here is not.
- `bun run cli tor-test` is a live check over the real Tor network. Run it
  after changing `cli/tor/` or the Tor bootstrap, not on every change.
  `bun run test:live:tor:cli` sends a file between two CLI processes over the
  same network; run it after changing `cli/commands/send.ts`, `receive.ts`, or
  `cli/transfer/`.
- `bun run test:live:code:cli` runs Code Exchange between two CLI processes —
  direct, a folder, and the Nostr relay fallback (`SCENARIOS=anonymous` adds the
  Tor one) — and `bun run test:live:code:cli-web` runs it between the CLI and a
  headless Chromium tab, both ways; run them after changing `cli/code/`,
  `src/lib/code-exchange/`, `src/lib/webrtc.ts`, or the relay fallback.
- `bun run test:live:pin:cli` runs PIN Exchange between two CLI processes over
  the same scenarios, carrying the PIN and the confirmation code between them;
  run it after changing `cli/pin/` or `src/lib/pin-exchange/`. A change there
  is a change to the browser tab too — both hosts run that handshake — so the
  web PIN flow is worth a look as well.

## Dependencies

Point the `@andrewtheguy/webtor-wasm` dependency at a local `webtor-rs` build
with `bun run webtor:local`, and back at the release with
`bun run webtor:released` before releasing; a `file:` dependency must never be
committed.

## Code

Always use `extractable: false` for Web Crypto API keys even for asymmetric keys
because public keys can always be exported.

Use async await instead of promises unless promises is meant for a specific reason

## Documentation

- No change logs on documentations since git already tracks all changes.
- The protocol documents in `docs/` (`INTEROP_PROTOCOL.md`,
  `CODE_EXCHANGE_PROTOCOL.md`, `TOR_TRANSPORT.md`, `ANONYMOUS_SIGNALING.md`,
  `NOSTR_FILE_RELAY.md`) specify what goes on the wire. The browser tab and the
  CLI run it from the same code, so there is no other implementation to
  coordinate with; keep a wire change and its document in the same change.

## Tools
- for one off python scripts, always run it with uv