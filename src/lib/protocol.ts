/**
 * Version of the interoperable pTransfer protocol: the wire contract that any
 * non-web implementation — today `ptransfer-cli` — has to match to transfer
 * with this app.
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
 * Nothing reads it at runtime — it is never sent, echoed, or negotiated. A
 * mismatch already fails closed at the PAKE seal or the metadata digest; this
 * constant exists so the two repositories can state their agreement in one
 * place, and so the CLI's interop test can check that they still agree.
 */
export const INTEROP_PROTOCOL_VERSION = '1';
