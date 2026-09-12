/**
 * The commit the web app was built from, which is the only release identity it
 * has: the tab is deployed straight from a commit, so there is no number to
 * bump for it. `CLI_VERSION` names a CLI release, and `PROTOCOL_VERSION` says
 * which peers interoperate; neither says anything about this build.
 *
 * `local` when built outside the deploy, which has no commit to name.
 */
export const GIT_COMMIT_HASH = __GIT_COMMIT_HASH__;
