/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

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

/**
 * V8's `captureStackTrace`, present in Chrome and absent elsewhere. The
 * browser build declares it optional here; Bun's own types already declare it
 * for the CLI, which is why `src/lib/errors.ts` does not.
 */
interface ErrorConstructor {
  captureStackTrace?(
    targetObject: object,
    constructorOpt?: NewableFunction,
  ): void;
}
