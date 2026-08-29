# Agent instructions

## Compatibility and versioning

- Strict no backward compatibility or legacy code path under any circumstances,
  bump package version to signal breaking changes instead.
- Always bump by patch version only for breaking changes, but only one bump per
  branch.
- Bump `INTEROP_PROTOCOL_VERSION` in `src/lib/protocol.ts` whenever anything
  specified in `docs/INTEROP_PROTOCOL.md` changes, and leave it alone otherwise;
  it is not the package version.

## Checks to run

- Always run `bun run lint` and then `bunx tsc -b` for any javascript changes to
  check and fix any issues after javascript related changes before committing
  code.
- Run `cargo clippy` and `cargo test` after rust changes.
- No `cargo fmt`.
- This repo has slow opt in tests, don't run `bun test` directly on normal flow
  when those opt in tests are not expected to run.

## Live interoperability tests

The live interoperability tests against `ptransfer-cli` live here and are run
from here:

- `bun run test:live:webrtc` — PIN Exchange over a real data channel
- `bun run test:live:code` — Code Exchange over hand-carried codes
- `bun run test:live:tor` — the onion transport

Both drive a sibling `ptransfer-cli` checkout, so run the matching one after
changing anything the two implementations share.

## Dependencies

Point the `@andrewtheguy/webtor-wasm` dependency at a local `webtor-rs` build
with `bun run webtor:local`, and back at the release with
`bun run webtor:released` before releasing; a `file:` dependency must never be
committed.

## Code

Always use `extractable: false` for Web Crypto API keys even for asymmetric keys
because public keys can always be exported.

## Documentation

- No change logs on documentations since git already tracks all changes.
- The companion CLI is `ptransfer-cli`
  (https://github.com/andrewtheguy/ptransfer-cli); this repo is the source of
  truth for everything the two share, so `docs/INTEROP_PROTOCOL.md`,
  `docs/CODE_EXCHANGE_PROTOCOL.md`, `docs/TOR_TRANSPORT.md`, and
  `docs/ANONYMOUS_SIGNALING.md` are specified here
  and the CLI implements against them rather than restating them. Editing one of
  those docs does not by itself concern the CLI; only a change to the normative
  surface each doc names in its "Changing this document" section does, and that
  shows up as a bumped `INTEROP_PROTOCOL_VERSION` or `TOR_HANDSHAKE_VERSION` —
  or, for the two docs that carry no version, as a change that fails closed on
  both sides.
  Keep CLI internals (its file names, crates, layout) out of these docs so the
  CLI can move without making them stale.
