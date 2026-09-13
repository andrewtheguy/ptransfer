/**
 * The compatibility version: two peers interoperate exactly when they carry
 * the same number, whatever app or CLI release each one runs. Bumped by one
 * with any change to what goes on the wire as specified in `docs/`, and never
 * for a release on its own. It is the one version the two hosts share: a CLI
 * release is `CLI_VERSION`, a tab is the commit it was built from, and
 * neither says anything about which peers work together.
 *
 * PIN Exchange sends it in the rendezvous and the claim, and a mismatch is
 * refused with both numbers named: there a divergence would otherwise only
 * surface as a wait that times out, once the handshake is past the point both
 * releases share. Code Exchange does not send it, since every divergence
 * there already fails closed, as its protocol document explains. The Tor
 * handshake's own `TOR_HANDSHAKE_VERSION` is sent and checked beside it.
 */
export const PROTOCOL_VERSION = 2;
