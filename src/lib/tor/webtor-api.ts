/**
 * The surface of `@andrewtheguy/webtor-wasm` as this codebase uses it, typed.
 *
 * The package's generated declarations return `any` from every async method,
 * because wasm-bindgen has no way to describe what a `js_sys::Promise`
 * resolves to. The interfaces below are that description, applied once here so
 * no caller has to hold `any` values.
 *
 * Nothing in this file touches a platform API: it is shared by the browser
 * loader in `./webtor.ts` and the CLI's loader in `cli/tor/webtor.ts`, which
 * differ only in where the binary comes from.
 */

/** A raw onion stream: bytes in, bytes out, nothing layered on top. */
export interface OnionStream {
  send(text: string): Promise<unknown>;
  sendBytes(payload: Uint8Array): Promise<unknown>;
  /** The next bytes the peer sent, or null at end of stream. */
  receive(): Promise<Uint8Array | null>;
  close(): Promise<unknown>;
}

/**
 * One inbound WebSocket message. The binding delivers binary frames too;
 * Nostr has no use for them, so the adapter that reads this treats one as a
 * protocol error rather than dropping it silently.
 */
export type OnionWebSocketMessage =
  | { type: 'text'; text: string }
  | { type: 'binary'; bytes: Uint8Array };

/**
 * A WebSocket spoken inside an onion stream: the HTTP upgrade, masking,
 * fragmentation, and control frames are all handled in WASM, so this is a
 * message queue and nothing more.
 */
export interface OnionWebSocket {
  send(text: string): Promise<unknown>;
  sendBinary(payload: Uint8Array): Promise<unknown>;
  /** The next message the relay sent, or null once it closes. */
  receive(): Promise<OnionWebSocketMessage | null>;
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
  /**
   * Take every log line instead of the console. Replaces the sink `log` and
   * `logPrefix` configure, so passing it with either is an error.
   */
  onLog?: (
    message: string,
    level: 'info' | 'success' | 'warn' | 'error',
  ) => void;
  /**
   * Handed every directory this client downloads, as a seed a later bootstrap
   * would take. `directoryCache()` is a pull and this is the push: a client
   * refreshes its directory while it runs, so exporting once after `create`
   * only ever stores the one it started with. A supplied `directorySeed` is
   * never handed back.
   */
  onDirectoryChange?: (seed: string) => void;
}

/**
 * What one directory seed says about itself, read by the Tor client rather
 * than by this app: parsing a consensus is webtor's job, and the two would
 * have to agree exactly on where the HSDir ring falls if both did it.
 *
 * The judgement built on top of it is ours — see `judgeDescription` in
 * `directory-cache.ts`.
 */
export interface DirectoryDescription {
  readonly validAfter: Date;
  readonly validUntil: Date;
  /** The onion-service time period this directory places descriptors in. */
  readonly timePeriod: number;
  /** The period covering `at`, in epoch milliseconds. */
  timePeriodAt(at: number): number;
}

/**
 * One HTTP/1.1 response from an onion service, buffered whole. A 4xx or 5xx
 * is a response, not a rejection.
 */
export interface OnionResponse {
  readonly status: number;
  readonly ok: boolean;
  /**
   * A `Headers` in a browser. Under Bun the binding hands back a plain
   * object keyed by lowercase header name instead, so read it through
   * something that accepts both rather than calling `get` on it.
   */
  readonly headers: Headers | Record<string, string>;
  bytes(): Uint8Array;
  text(): string;
}

export interface OnionFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  /** Most the buffered response may hold, headers and body together. */
  maxResponseBytes?: number;
}

export interface WebtorClient {
  /** One HTTP request to `http://<address>.onion/...`. */
  fetch(url: string, options?: OnionFetchOptions): Promise<OnionResponse>;
  connectStream(address: string, port: number): Promise<OnionStream>;
  /** Open a WebSocket to `ws://<address>.onion[:port][/path]`. */
  connectWebSocket(
    url: string,
    options?: { maxMessageBytes?: number; timeoutMs?: number },
  ): Promise<OnionWebSocket>;
  publishOnionService(options?: PublishOptions): Promise<OnionService>;
  /**
   * The verified directory in force right now, to seed the next bootstrap.
   * A snapshot at the moment of the call — `onDirectoryChange` is how a
   * caller hears about a newer one.
   */
  directoryCache(): Promise<string>;
  close(): Promise<unknown>;
}

/**
 * The module `@andrewtheguy/webtor-wasm` exports, typed. `default` is the
 * wasm-bindgen initializer; it takes the binary itself or where to fetch it
 * from, which is the one place the two hosts differ: the browser hands it a
 * URL Vite emitted, the CLI hands it the bytes it read from disk.
 */
export interface WebtorModule {
  default: (init: {
    module_or_path: string | URL | Uint8Array | ArrayBuffer;
  }) => Promise<unknown>;
  WebtorClient: {
    create(options?: WebtorClientOptions): Promise<WebtorClient>;
  };
  /**
   * Read a seed's own account of itself. Touches no network and verifies
   * nothing: `create` revalidates any seed against the pinned directory
   * authorities whatever this said.
   */
  describeDirectory(seed: string): DirectoryDescription;
}
