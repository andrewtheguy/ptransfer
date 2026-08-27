Strict no backward compatibility or legacy code path under any circumstances, bump package version to signal breaking changes instead.

Always use extractable: false for Web Crypto API keys even for asymmetric keys because public keys can always be exported

Always run bun run lint and then bunx tsc -b for any javascript changes to check and fix any issues after javascript related changes before committing code

run cargo clippy and cargo test after rust changes

no cargo fmt

always bump by patch version only for breaking changes, but only one bump per branch

point the @andrewtheguy/webtor-wasm dependency at a local webtor-rs build with bun run webtor:local, and back at the release with bun run webtor:released, before committing; a file: dependency must never be committed

bump INTEROP_PROTOCOL_VERSION in src/lib/protocol.ts whenever anything specified in docs/INTEROP_PROTOCOL.md changes, and leave it alone otherwise; it is not the package version
