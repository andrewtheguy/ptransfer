// Offline QR transfer app, suggested when a direct P2P connection can't be made.
export const OFFLINE_QR_TRANSFER_URL = 'https://qrsecure.kuvi.dev/transfer';

/**
 * The companion command-line app. It speaks the same wire formats as this app
 * — PIN Exchange (including anonymous signaling), Code Exchange and both of
 * its fallbacks, and the Tor Onion Service mode — so either end of a transfer
 * may be a browser tab or the CLI.
 *
 * The shared contracts live in docs/INTEROP_PROTOCOL.md and the mode-specific
 * protocol documents beside it.
 */
export const PTRANSFER_CLI_URL =
  'https://github.com/andrewtheguy/ptransfer-cli';

/** One-line installer published from that repo's GitHub Pages site. */
export const PTRANSFER_CLI_INSTALL_SH =
  'curl -sSL https://andrewtheguy.github.io/ptransfer-cli/install.sh | bash';
