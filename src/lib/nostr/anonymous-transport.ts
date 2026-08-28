import {
  bootstrapTorClient,
  closeTorClient,
  type TorBridge,
} from '@/lib/tor/client';
import type { OnionWebSocket, WebtorClient } from '@/lib/tor/webtor';

/**
 * Anonymous signaling: the browser Tor client, dressed as a `WebSocket`
 * constructor so `nostr-tools` can carry the PIN Exchange handshake to onion
 * relays without knowing anything has changed underneath it.
 *
 * Everything above this file is untouched — the same events, subscriptions,
 * signatures, SPAKE2 exchange, and sealed payloads. What changes is only which
 * socket implementation the relay pool builds on and, as a consequence, which
 * relays are reachable at all: the adapter refuses anything but
 * `ws://<v3 address>.onion` (see `normalizeOnionRelayUrl`), so there is no
 * arrangement of relay lists that quietly sends a clearnet request from a tab
 * that asked for this.
 *
 * One Tor client is shared by every relay socket in a signaling session, but
 * each socket is its own rendezvous — a descriptor fetch from an HSDir, an
 * introduction circuit, and a rendezvous circuit — so relay pools are kept
 * small on purpose.
 */

/**
 * How long the whole bootstrap may take before the transport gives up.
 *
 * A cold start downloads the consensus and every HSDir microdescriptor one hop
 * from the bridge, which is minutes rather than seconds; a warm one seeded
 * from IndexedDB is quick. The budget covers the slow case, because failing at
 * four minutes on a path that would have worked at five just costs the user
 * the whole wait again.
 */
const BOOTSTRAP_TIMEOUT_MS = 300_000;

/**
 * How long a relay socket opened through this transport may take to connect.
 *
 * Opening one is a whole rendezvous — an HSDir descriptor fetch, an
 * introduction circuit, and a rendezvous circuit — which is minutes on a bad
 * day and still the fastest path available. Every pool built on this adapter
 * has to apply it, or its sockets are declared dead on a clearnet clock long
 * before a working circuit would have finished.
 */
export const ANONYMOUS_RELAY_CONNECTION_TIMEOUT_MS = 180_000;

/**
 * The `error` event this adapter emits.
 *
 * Deliberately not `new ErrorEvent(...)`. That constructor is a browser global
 * and nothing else defines it — Node does not — so building one here turns a
 * clean protocol error into a ReferenceError thrown inside the read loop, and
 * the adapter hangs rather than closing. Everything that reads this event
 * wants `message` and nothing else: nostr-tools' `onerror` handler takes
 * `ev.message` as the reason it rejects a connection, and so do this file's
 * tests. An Event carrying one is the whole contract.
 */
function errorEvent(message: string): Event & { message: string } {
  return Object.assign(new Event('error'), { message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Anonymous signaling failed';
}

export interface AnonymousTransportOptions {
  /** Which Snowflake bridge this tab reaches the Tor network through. */
  bridge: TorBridge;
  /** Progress for the UI while the client bootstraps. */
  onStatus?: (message: string) => void;
}

/**
 * Race a bootstrap against the deadline, closing a client that arrives too
 * late — otherwise it would sit holding circuits for a session that has
 * already reported failure.
 */
function withBootstrapDeadline(
  pending: Promise<WebtorClient>,
): Promise<WebtorClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      settled = true;
      reject(
        new Error(
          'Anonymous signaling could not reach the Tor network within 5 minutes',
        ),
      );
    }, BOOTSTRAP_TIMEOUT_MS);

    void pending.then(
      (client) => {
        if (settled) {
          void closeTorClient(client);
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

/** One bootstrapped Tor client and the sockets opened through it. */
export class AnonymousSignalingTransport {
  private readonly clientPromise: Promise<WebtorClient>;
  private closed = false;
  /**
   * Every socket this transport has created that has not yet emitted `close`.
   * The relay pool only closes sockets it sees as OPEN, so one still building
   * its onion circuit when the session ends would otherwise finish that
   * rendezvous for nobody; `close()` reaches them all.
   */
  private readonly sockets = new Set<{
    close(code?: number, reason?: string): void;
  }>();
  /** The bootstrapped client, once there is one for `close()` to close. */
  private client: WebtorClient | null = null;
  /** Rejects `clientPromise` on `close()`; see the race below. */
  private cancelBootstrap: (error: Error) => void = () => {};

  readonly websocketImplementation: typeof WebSocket;

  constructor(options: AnonymousTransportOptions) {
    const cancelled = new Promise<never>((_, reject) => {
      this.cancelBootstrap = reject;
    });

    const bootstrap = withBootstrapDeadline(
      bootstrapTorClient({
        bridge: options.bridge,
        onStatus: options.onStatus,
      }),
    ).then(async (client) => {
      if (this.closed) {
        // Cancelled while this was still in flight: it holds circuits for a
        // session that has already reported itself finished.
        await closeTorClient(client);
        throw new Error('Anonymous signaling was cancelled');
      }
      this.client = client;
      return client;
    });

    // Racing the cancellation is what makes `close()` prompt, and that is a
    // correctness property rather than a nicety. Everything that awaits this
    // — `waitUntilReady`, and every socket still building its circuit — would
    // otherwise stay suspended until the bootstrap finishes or the five-minute
    // deadline fires. For a cancelled transfer that is minutes during which
    // the hook that started it is still inside its own `try`, believing it
    // owns a transfer the user has already abandoned.
    //
    // Both inputs keep a handler from here for their whole life, so a late
    // rejection from either is never an unhandled one.
    this.clientPromise = Promise.race([bootstrap, cancelled]);
    // Nothing awaits the result until a socket opens or a fallback asks for
    // the client, so a bootstrap that fails while the code is still on screen
    // — or a transfer that connects directly and never asks — would surface
    // as an unhandled rejection and bury the real error in console noise.
    // Marking it handled costs a real awaiter nothing: it awaits this same
    // promise and still sees the error. As NostrClient does with its
    // connectionReady.
    void this.clientPromise.catch(() => {});

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

        private socket: OnionWebSocket | null = null;
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
            this.discardSocket();
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

        private async open(pending: Promise<WebtorClient>): Promise<void> {
          try {
            const client = await pending;
            if (this.readyState !== AnonymousSignalingWebSocket.CONNECTING) {
              this.finishClose(true, 1000, 'Cancelled before connection');
              return;
            }
            const socket = await client.connectWebSocket(this.url);
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
            this.discardSocket();
            this.finishClose(false, 1006, 'Tor WebSocket connection failed');
          }
        }

        private async readMessages(socket: OnionWebSocket): Promise<void> {
          while (this.readyState === AnonymousSignalingWebSocket.OPEN) {
            const message = await socket.receive();
            if (message == null) {
              this.discardSocket();
              this.finishClose(true, 1000, 'Relay closed the connection');
              return;
            }
            if (message.type !== 'text') {
              this.emitError('Relay sent a binary message on a Nostr socket');
              this.discardSocket();
              this.finishClose(false, 1003, 'Unsupported binary message');
              return;
            }
            const event = new MessageEvent<string>('message', {
              data: message.text,
            });
            this.dispatchEvent(event);
            this.onmessage?.call(this as unknown as WebSocket, event);
          }
        }

        /**
         * Hand the onion stream back before this adapter forgets it exists.
         *
         * `finishClose` drops the reference and removes the adapter from the
         * transport's set, so a stream still held at that point is
         * unreachable: the transport's own `close()` cannot get to it either,
         * and the circuit and unread queue behind it live until the whole Tor
         * client goes. Every path that finalizes the adapter without having
         * closed the stream itself comes through here first. `close()` does
         * not, because it closes the stream and waits for it.
         */
        private discardSocket(): void {
          const socket = this.socket;
          this.socket = null;
          if (!socket) return;
          void Promise.resolve(socket.close()).catch(() => {
            // Teardown: the adapter has already reported why it is closing,
            // and a stream the relay dropped refuses this by definition.
          });
        }

        private emitError(message: string): void {
          const event = errorEvent(message);
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

  /** Resolves once Tor is bootstrapped; rejects with why it could not be. */
  async waitUntilReady(): Promise<void> {
    await this.clientPromise;
  }

  /**
   * The bootstrapped client itself, for a caller that needs Tor for more than
   * relay sockets.
   *
   * Code Exchange's anonymous relay is the one such caller: its control
   * channel is relay sockets like any other, but its data path is an onion
   * service published on this same client. Two clients would mean two
   * bootstraps — minutes each, and the whole reason the receiving page starts
   * one the moment it takes the offer in. Ownership does not change hands:
   * `close()` still closes it, so a borrower must not.
   */
  torClient(): Promise<WebtorClient> {
    return this.clientPromise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of [...this.sockets]) {
      socket.close(1001, 'Anonymous signaling closed');
    }
    // Wake every waiter now rather than whenever the bootstrap gets around to
    // finishing. A bootstrap still in flight closes the client it eventually
    // produces on its own, having seen `closed`.
    this.cancelBootstrap(new Error('Anonymous signaling was cancelled'));
    const client = this.client;
    this.client = null;
    if (client) void closeTorClient(client);
  }
}
