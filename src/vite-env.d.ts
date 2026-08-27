/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;
declare const __GIT_COMMIT_HASH__: string;

interface ImportMetaEnv {
  /**
   * A Snowflake bridge for the Tor transport other than the public one, with
   * its identity fingerprint. Development only, and both or neither — see
   * `src/lib/tor/client.ts`.
   */
  readonly VITE_TOR_BRIDGE_URL?: string;
  readonly VITE_TOR_BRIDGE_FINGERPRINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
