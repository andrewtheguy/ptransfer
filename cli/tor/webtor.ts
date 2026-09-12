import { readFile } from 'node:fs/promises';
import webtorBinary from '@andrewtheguy/webtor-wasm/webtor_wasm_bg.wasm' with {
  type: 'file',
};
import type { WebtorModule } from '@/lib/tor/webtor-api';

/**
 * Loading the Tor client (`@andrewtheguy/webtor-wasm`) under Bun.
 *
 * The same package the browser tab runs, unmodified: everything it needs from
 * its host — `WebSocket`, `fetch`, `setTimeout`, `performance`, SubtleCrypto —
 * Bun provides as globals, so the only difference from `src/lib/tor/webtor.ts`
 * is where the binary comes from. The generated glue would `fetch` it next to
 * the module, which under Bun means a `file:` URL; reading the bytes ourselves
 * is one less thing that has to work.
 *
 * The `type: 'file'` import is the seam between the two ways the CLI runs: as
 * `bun cli/main.ts` it is the path of the file in `node_modules`, and inside a
 * `bun build --compile` binary it is the path of the copy embedded in the
 * executable, which `readFile` reads the same way.
 */

let modulePromise: Promise<WebtorModule> | undefined;

export function loadWebtor(): Promise<WebtorModule> {
  modulePromise ??= (async () => {
    try {
      const module = (await import(
        '@andrewtheguy/webtor-wasm'
      )) as unknown as WebtorModule;
      await module.default({ module_or_path: await readFile(webtorBinary) });
      return module;
    } catch (error: unknown) {
      modulePromise = undefined;
      throw error;
    }
  })();
  return modulePromise;
}
