import webtorWasmUrl from '@andrewtheguy/webtor-wasm/webtor_wasm_bg.wasm?url';

/**
 * Loading the browser Tor client (`@andrewtheguy/webtor-wasm`) and the typed
 * shapes the rest of this app uses it through.
 *
 * The package's generated declarations return `any` from every async method,
 * because wasm-bindgen has no way to describe what a `js_sys::Promise`
 * resolves to. The interfaces below are that description, applied once here so
 * no caller has to hold `any` values.
 *
 * The WASM binary is passed explicitly rather than letting the generated glue
 * resolve it next to the module: Vite pre-bundles installed packages into
 * `node_modules/.vite/deps/`, where the binary is not, so the default resolution
 * fetches the SPA fallback HTML and instantiation dies on the magic word. Same
 * pattern as `src/lib/wasm/rxingWasm.ts`.
 */

/** A raw onion stream: bytes in, bytes out, nothing layered on top. */
export interface OnionStream {
  send(text: string): Promise<unknown>;
  sendBytes(payload: Uint8Array): Promise<unknown>;
  /** The next bytes the peer sent, or null at end of stream. */
  receive(): Promise<Uint8Array | null>;
  close(): Promise<unknown>;
}

/** A v3 onion service published from this tab. */
export interface OnionService {
  readonly onionAddress: string;
  /** The next client stream, or null once the service is closed. */
  accept(): Promise<OnionStream | null>;
  close(): Promise<unknown>;
}

export interface PublishOptions {
  introPoints?: number;
}

export interface WebtorClientOptions {
  bridge?: 'websocket' | 'webrtc';
  stunUrls?: string[];
  /** A bridge other than the public one; both or neither. */
  bridgeUrl?: string;
  bridgeFingerprint?: string;
  directorySeed?: string;
  connectionTimeoutMs?: number;
  log?: boolean;
  logPrefix?: string;
}

export interface WebtorClient {
  connectStream(address: string, port: number): Promise<OnionStream>;
  publishOnionService(options?: PublishOptions): Promise<OnionService>;
  /** The verified directory from this bootstrap, to seed the next one. */
  directoryCache(): Promise<string>;
  close(): Promise<unknown>;
}

interface WebtorModule {
  default: (init: { module_or_path: string }) => Promise<unknown>;
  WebtorClient: {
    create(options?: WebtorClientOptions): Promise<WebtorClient>;
  };
}

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
