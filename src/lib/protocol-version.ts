/**
 * The compatibility version: two peers interoperate exactly when they carry
 * the same number, whatever app or CLI release each one runs. Bumped by one
 * with any change to what goes on the wire as specified in `docs/`, and never
 * for a release on its own. It is the one version the two hosts share: a CLI
 * release is `CLI_VERSION`, a tab is the commit it was built from, and
 * neither says anything about which peers work together.
 *
 * It does not travel on the wire. Every divergence it stands for already
 * fails closed, as each protocol document explains; this is the number a
 * person compares before a transfer. The Tor handshake's own
 * `TOR_HANDSHAKE_VERSION` is the one version that is sent and checked.
 */
export const PROTOCOL_VERSION = 1;
