import webtorWasmUrl from '@andrewtheguy/webtor-wasm/webtor_wasm_bg.wasm?url';
import type { WebtorModule } from './webtor-api';

/**
 * Loading the browser Tor client (`@andrewtheguy/webtor-wasm`) in a page.
 *
 * The typed shapes the rest of this app uses it through live in
 * `./webtor-api.ts` and are re-exported here, so a caller that only needs a
 * type does not pull in this loader — the CLI's loader in `cli/tor/webtor.ts`
 * returns the same `WebtorModule` from the binary on disk.
 *
 * The WASM binary is passed explicitly rather than letting the generated glue
 * resolve it next to the module: Vite pre-bundles installed packages into
 * `node_modules/.vite/deps/`, where the binary is not, so the default resolution
 * fetches the SPA fallback HTML and instantiation dies on the magic word. Same
 * pattern as `src/lib/wasm/rxingWasm.ts`.
 */

export type * from './webtor-api';

let modulePromise: Promise<WebtorModule> | undefined;

/**
 * Load the WASM Tor client. Deliberately a dynamic import: the binary is 1.7
 * MB and only the Tor transfer mode ever needs it, so it must not land in the
 * bundle every visitor downloads.
 */
export function loadWebtor(): Promise<WebtorModule> {
  modulePromise ??= import('@andrewtheguy/webtor-wasm')
    .then(async (module) => {
      const typed = module as unknown as WebtorModule;
      await typed.default({ module_or_path: webtorWasmUrl });
      return typed;
    })
    .catch((error: unknown) => {
      modulePromise = undefined;
      throw error;
    });
  return modulePromise;
}
