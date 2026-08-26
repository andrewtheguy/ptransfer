import anonymousSignalingWasmUrl from '@andrewtheguy/anonymous-signaling-wasm/anonymous_signaling_wasm_bg.wasm?url';
import { getStunUrls } from '../webrtc-config';
import {
  loadTorDirectoryCache,
  saveTorDirectoryCache,
} from './tor-directory-cache';
import { loadTorDirectorySnapshot } from './tor-directory-snapshot';

interface WasmAnonymousSignalingSocket {
  send(text: string): Promise<unknown>;
  receive(): Promise<string | null | undefined>;
  close(): Promise<unknown>;
}

interface WasmAnonymousSignalingClient {
  connect(relayUrl: string): Promise<WasmAnonymousSignalingSocket>;
  directoryCache(): Promise<string>;
  close(): Promise<unknown>;
}

const CLIENT_INITIALIZATION_TIMEOUT_MS = 300_000;

/**
 * Directory data for Rust to bootstrap from. The snapshot the site serves is
 * preferred because it is refreshed centrally; the copy left by this browser's
 * last successful bootstrap covers a deployment that serves no snapshot.
 */
async function loadDirectorySeed(): Promise<string | undefined> {
  const snapshot = await loadTorDirectorySnapshot();
  return snapshot ?? (await loadTorDirectoryCache());
}

type WasmModule = typeof import('@andrewtheguy/anonymous-signaling-wasm');

let wasmModulePromise: Promise<WasmModule> | null = null;

async function loadWasmModule(): Promise<WasmModule> {
  wasmModulePromise ??= import('@andrewtheguy/anonymous-signaling-wasm')
    .then(async (module) => {
      // The generated glue defaults to resolving the binary next to itself.
      // Vite pre-bundles the package into `.vite/deps/`, where the binary is
      // not, so that default resolves to a path the dev server answers with
      // index.html and instantiation fails on the HTML. Handing init an
      // explicit `?url` import is what the other WASM packages here do.
      await module.default({ module_or_path: anonymousSignalingWasmUrl });
      return module;
    })
    .catch((error: unknown) => {
      wasmModulePromise = null;
      throw error;
    });
  return wasmModulePromise;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Anonymous signaling failed';
}

function makeErrorEvent(message: string): ErrorEvent {
  return new ErrorEvent('error', { message });
}

function withInitializationDeadline(
  pendingClient: Promise<WasmAnonymousSignalingClient>,
): Promise<WasmAnonymousSignalingClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      settled = true;
      reject(
        new Error(
          'Anonymous signaling could not establish and verify Tor within 5 minutes',
        ),
      );
    }, CLIENT_INITIALIZATION_TIMEOUT_MS);

    void pendingClient.then(
      (client) => {
        if (settled) {
          void Promise.resolve(client.close()).catch(() => {
            // The timed-out client is already unusable to the caller.
          });
          return;
        }
        settled = true;
        globalThis.clearTimeout(timeout);
        resolve(client);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export interface AnonymousSignalingTransportOptions {
  /**
   * Reach the Snowflake bridge over a direct WebSocket instead of a volunteer
   * WebRTC proxy. The direct path skips the broker and STUN entirely.
   */
  webSocketBridge: boolean;
}

/**
 * One Tor client and one verified Tor circuit shared by every Nostr relay
 * socket in a signaling session.
 */
export class AnonymousSignalingTransport {
  private readonly clientPromise: Promise<WasmAnonymousSignalingClient>;
  private closed = false;
  /**
   * Every socket this transport has created that has not yet emitted
   * `close`. The relay pool only closes sockets it sees as OPEN, so one
   * still building its onion circuit when the session ends would otherwise
   * finish that rendezvous for nobody; `close()` reaches them all.
   */
  private readonly sockets = new Set<{
    close(code?: number, reason?: string): void;
  }>();

  readonly websocketImplementation: typeof WebSocket;

  constructor(options: AnonymousSignalingTransportOptions) {
    const pendingClient = Promise.all([
      loadWasmModule(),
      loadDirectorySeed(),
    ]).then(async ([module, directorySeed]) => {
      // Rust starts from this directory data when it is present and still
      // valid, and downloads a consensus over the bridge otherwise.
      const client = (await module.AnonymousSignalingClient.create(
        directorySeed,
        getStunUrls(),
        options.webSocketBridge,
      )) as WasmAnonymousSignalingClient | undefined;
      if (!client) throw new Error('webtor returned no signaling client');
      void client
        .directoryCache()
        .then(saveTorDirectoryCache)
        .catch((error: unknown) => {
          console.info(
            '[Anonymous signaling] Could not export the Tor directory cache:',
            errorMessage(error),
          );
        });
      return client;
    });

    this.clientPromise = withInitializationDeadline(pendingClient).then(
      async (client) => {
        if (this.closed) {
          await client.close();
          throw new Error('Anonymous signaling was cancelled');
        }
        return client;
      },
    );

    const clientPromise = this.clientPromise;
    const sockets = this.sockets;

    this.websocketImplementation =
      class AnonymousSignalingWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readonly CLOSING = 2;
        readonly CLOSED = 3;

        readonly url: string;
        readonly protocol = '';
        readonly extensions = '';
        binaryType: BinaryType = 'blob';
        bufferedAmount = 0;
        readyState = AnonymousSignalingWebSocket.CONNECTING;

        onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
        onmessage:
          | ((this: WebSocket, ev: MessageEvent<string>) => unknown)
          | null = null;
        onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
        onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;

        private socket: WasmAnonymousSignalingSocket | null = null;
        private closeEmitted = false;

        constructor(url: string | URL, protocols?: string | string[]) {
          super();
          this.url = url.toString();
          if (
            (typeof protocols === 'string' && protocols.length > 0) ||
            (Array.isArray(protocols) && protocols.length > 0)
          ) {
            throw new DOMException(
              'Anonymous signaling does not support WebSocket subprotocols',
              'NotSupportedError',
            );
          }
          sockets.add(this);
          void this.open(clientPromise);
        }

        send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          // WebSocket semantics: only a send before the connection opens is an
          // error. After CLOSING/CLOSED the data is silently discarded.
          if (this.readyState === AnonymousSignalingWebSocket.CONNECTING) {
            throw new DOMException(
              'WebSocket is not open',
              'InvalidStateError',
            );
          }
          if (typeof data !== 'string') {
            throw new DOMException(
              'Nostr signaling only supports text messages',
              'NotSupportedError',
            );
          }
          if (
            !this.socket ||
            this.readyState !== AnonymousSignalingWebSocket.OPEN
          ) {
            return;
          }

          void this.socket.send(data).catch((error: unknown) => {
            this.emitError(errorMessage(error));
            this.finishClose(false, 1006, 'Tor WebSocket send failed');
          });
        }

        close(code = 1000, reason = ''): void {
          if (
            this.readyState === AnonymousSignalingWebSocket.CLOSING ||
            this.readyState === AnonymousSignalingWebSocket.CLOSED
          ) {
            return;
          }
          this.readyState = AnonymousSignalingWebSocket.CLOSING;
          if (!this.socket) return;

          void this.socket
            .close()
            .catch((error: unknown) => this.emitError(errorMessage(error)))
            .finally(() => this.finishClose(true, code, reason));
        }

        private async open(
          pendingClient: Promise<WasmAnonymousSignalingClient>,
        ): Promise<void> {
          try {
            const client = await pendingClient;
            if (this.readyState !== AnonymousSignalingWebSocket.CONNECTING) {
              this.finishClose(true, 1000, 'Cancelled before connection');
              return;
            }
            const socket = await client.connect(this.url);
            if (this.readyState !== AnonymousSignalingWebSocket.CONNECTING) {
              await socket.close();
              this.finishClose(true, 1000, 'Cancelled before connection');
              return;
            }

            this.socket = socket;
            this.readyState = AnonymousSignalingWebSocket.OPEN;
            const event = new Event('open');
            this.dispatchEvent(event);
            this.onopen?.call(this as unknown as WebSocket, event);
            await this.readMessages(socket);
          } catch (error) {
            // An intentional close() tears the stream out from under the read
            // loop; that rejection is not an error event the caller should see.
            if (
              this.readyState === AnonymousSignalingWebSocket.OPEN ||
              this.readyState === AnonymousSignalingWebSocket.CONNECTING
            ) {
              this.emitError(errorMessage(error));
            }
            this.finishClose(false, 1006, 'Tor WebSocket connection failed');
          }
        }

        private async readMessages(
          socket: WasmAnonymousSignalingSocket,
        ): Promise<void> {
          while (this.readyState === AnonymousSignalingWebSocket.OPEN) {
            const message = await socket.receive();
            if (message == null) {
              this.finishClose(true, 1000, 'Relay closed the connection');
              return;
            }
            const event = new MessageEvent<string>('message', {
              data: message,
            });
            this.dispatchEvent(event);
            this.onmessage?.call(this as unknown as WebSocket, event);
          }
        }

        private emitError(message: string): void {
          const event = makeErrorEvent(message);
          this.dispatchEvent(event);
          this.onerror?.call(this as unknown as WebSocket, event);
        }

        private finishClose(
          wasClean: boolean,
          code: number,
          reason: string,
        ): void {
          if (this.closeEmitted) return;
          this.closeEmitted = true;
          sockets.delete(this);
          this.readyState = AnonymousSignalingWebSocket.CLOSED;
          this.socket = null;
          const event = new CloseEvent('close', { wasClean, code, reason });
          this.dispatchEvent(event);
          this.onclose?.call(this as unknown as WebSocket, event);
        }
      } as unknown as typeof WebSocket;
  }

  async waitUntilReady(): Promise<void> {
    await this.clientPromise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of [...this.sockets]) {
      socket.close(1001, 'Anonymous signaling closed');
    }
    void this.clientPromise
      .then((client) => client.close())
      .catch(() => {
        // Initialization errors are reported by the WebSocket connection.
      });
  }
}
