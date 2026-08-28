/**
 * Version of the interoperable pTransfer protocol: the wire contract that any
 * non-web implementation — today `ptransfer-cli`, the companion command-line
 * app at https://github.com/andrewtheguy/ptransfer-cli — has to match to
 * transfer with this app.
 *
 * Its scope is deliberately narrower than the app: PIN Exchange signaling and
 * the shared WebRTC data-channel transfer layer, and nothing else. Code
 * Exchange and the Nostr file-relay fallback are web-only and stay outside the
 * contract while they are still changing shape. `docs/INTEROP_PROTOCOL.md`
 * defines exactly what is in and out.
 *
 * A single monotonically increasing integer, deliberately not the app version:
 * the app bumps its patch version for any breaking change, most of which land
 * in parts of the app no other implementation speaks. Bump this one when
 * anything specified in `docs/INTEROP_PROTOCOL.md` changes, and leave it alone
 * otherwise.
 *
 * Nothing reads it at runtime — it is never sent, echoed, or negotiated. This
 * is a build-time coordination value: the two repositories state their
 * agreement in one place, and the CLI's interop test checks they still agree.
 * Some mismatches would surface on their own (a changed KDF label or transcript
 * field list breaks the PAKE seals), but many would not — rotation windows,
 * budgets, timeouts, and size limits are agreed only by both sides implementing
 * the same spec. Do not treat a completed transfer as evidence of a match.
 */
export const INTEROP_PROTOCOL_VERSION = '4';
