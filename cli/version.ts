import packageMetadata from '../package.json';

/**
 * The CLI's release version: what the `Release CLI` workflow publishes binaries
 * under, and the `v<version>` tag it creates when it does. It is the
 * `package.json` version, which nothing else releases on: the
 * web app carries no number of its own, only the commit it was built from in
 * `src/lib/build-commit.ts`.
 *
 * Bumped by a patch, once per branch, for anything a CLI user or a script can
 * see — a flag or an environment variable, what a command prints, what a
 * screen shows, a stored format — breaking or not, and left alone for a
 * change only the tab sees. A release may bump it on its own. It
 * says nothing about which peers interoperate; that is `PROTOCOL_VERSION`,
 * shared with the web app because both hosts run the same protocol code.
 */
export const CLI_VERSION = packageMetadata.version;
