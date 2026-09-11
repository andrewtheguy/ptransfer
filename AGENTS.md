# Agent instructions

## Compatibility and versioning

- Strict no backward compatibility or legacy code path under any circumstances,
  bump package version to signal breaking changes instead.
- Always bump by patch version only for breaking changes, but only one bump per
  branch.
- Bump `TOR_HANDSHAKE_VERSION` in `src/lib/tor/handshake.ts` whenever the Tor
  handshake frames specified in `docs/TOR_TRANSPORT.md` change, and leave it
  alone otherwise; it travels on the wire and is refused on a mismatch. Nothing
  else carries a protocol version.

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
  bindings. The scope and the release targets are in `docs/ROADMAP.md`.

## Checks to run

- Always run `bun run lint` and then `bunx tsc -b` for any javascript changes to
  check and fix any issues after javascript related changes before committing
  code. `tsc -b` type-checks `cli/` through `tsconfig.cli.json`, with no DOM
  library, which is what keeps browser-only code out of it.
- This repo has slow opt in tests, don't run `bun test` directly on normal flow
  when those opt in tests are not expected to run.
- `bun run cli tor-test` is a live check over the real Tor network. Run it
  after changing `cli/tor/` or the Tor bootstrap, not on every change.
  `bun run test:live:tor:cli` sends a file between two CLI processes over the
  same network; run it after changing `cli/commands/send.ts`, `receive.ts`, or
  `cli/transfer/`.

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