// Offline QR transfer app, suggested when a direct P2P connection can't be made.
export const OFFLINE_QR_TRANSFER_URL = 'https://qrsecure.kuvi.dev/transfer';

/**
 * The companion command-line app. It speaks the same wire formats as this app
 * — PIN Exchange (including anonymous signaling) and the Tor Onion Service
 * mode — so either end of a transfer may be a browser tab or the CLI. Code
 * Exchange is web-only and has no CLI counterpart.
 *
 * See docs/INTEROP_PROTOCOL.md for what the two implementations must agree on.
 */
export const PTRANSFER_CLI_URL =
  'https://github.com/andrewtheguy/ptransfer-cli';

/** One-line installers published from that repo's GitHub Pages site. */
export const PTRANSFER_CLI_INSTALL_SH =
  'curl -sSL https://andrewtheguy.github.io/ptransfer-cli/install.sh | bash';
export const PTRANSFER_CLI_INSTALL_PS1 =
  'irm https://andrewtheguy.github.io/ptransfer-cli/install.ps1 | iex';
