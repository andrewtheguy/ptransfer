// Offline QR transfer app, suggested when a direct P2P connection can't be made.
export const OFFLINE_QR_TRANSFER_URL = 'https://qrsecure.kuvi.dev/transfer';

/**
 * This repository: the web app and the command line are the same source, so
 * there is one place to point at for both.
 */
export const PTRANSFER_REPO_URL = 'https://github.com/andrewtheguy/ptransfer';

/**
 * The command line's documentation. `cli/` imports this app's `src/lib`
 * directly — the same protocol, crypto and Tor code — so a tab and a terminal
 * are two hosts running one implementation and interoperate whenever their
 * protocol versions match.
 */
export const PTRANSFER_CLI_DOCS_URL = `${PTRANSFER_REPO_URL}#command-line`;

/** Where each release publishes the CLI's self-contained executables. */
export const PTRANSFER_CLI_RELEASES_URL = `${PTRANSFER_REPO_URL}/releases`;

/**
 * The one-line installer, `install.sh` at the root of this repository. Linux
 * and macOS only: there is no Windows build, and the CLI refuses that platform
 * up front rather than half-supporting it.
 */
export const PTRANSFER_CLI_INSTALL_SH =
  'curl -fsSL https://raw.githubusercontent.com/andrewtheguy/ptransfer/main/install.sh | bash';
