import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The seam is `@/lib/tor/client`: bootstrapping, directory seeding, and the
 * bridge choice are that module's job and are tested there. What is left here
 * is the only thing this file adds — a browser `WebSocket` built on top of an
 * onion stream, which `nostr-tools` drives without knowing the difference.
 */
const torMocks = vi.hoisted(() => {
  const sent: string[] = [];
  const closeSocket = vi.fn(async () => undefined);
  const closeClient = vi.fn(async () => undefined);
  let received = false;
  const socket = {
    send: vi.fn(async (text: string) => {
      sent.push(text);
    }),
    sendBinary: vi.fn(async () => undefined),
    receive: vi.fn(async () => {
      if (!received) {
        received = true;
        return { type: 'text', text: '["EOSE","subscription"]' };
      }
      return null;
    }),
    close: closeSocket,
  };
  const client = {
    connectStream: vi.fn(),
    connectWebSocket: vi.fn(async () => socket),
    publishOnionService: vi.fn(),
    directoryCache: vi.fn(async () => '{"version":1}'),
    close: closeClient,
  };
  return {
    client,
    closeClient,
    closeSocket,
    sent,
    bootstrap: vi.fn(async () => client),
    reset() {
      received = false;
      sent.length = 0;
    },
  };
});

vi.mock('@/lib/tor/client', () => ({
  bootstrapTorClient: torMocks.bootstrap,
  closeTorClient: torMocks.closeClient,
}));

import { AnonymousSignalingTransport } from './anonymous-transport';

const RELAY =
  'ws://oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion';

describe('AnonymousSignalingTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    torMocks.reset();
    torMocks.bootstrap.mockResolvedValue(torMocks.client);
  });

  it('adapts the onion socket to the browser WebSocket event API', async () => {
    const transport = new AnonymousSignalingTransport({ bridge: 'websocket' });
    await transport.waitUntilReady();

    const socket = new transport.websocketImplementation(RELAY);
    const open = new Promise<void>((resolve) =>
      socket.addEventListener('open', () => resolve(), { once: true }),
    );
    const message = new Promise<string>((resolve) =>
      socket.addEventListener(
        'message',
        (event) => resolve((event as MessageEvent<string>).data),
        { once: true },
      ),
    );
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener('close', () => resolve(), { once: true }),
    );

    await open;
    socket.send('["REQ","subscription",{}]');

    await expect(message).resolves.toBe('["EOSE","subscription"]');
    await closed;
    expect(torMocks.client.connectWebSocket).toHaveBeenCalledWith(RELAY);
    expect(torMocks.sent).toEqual(['["REQ","subscription",{}]']);

    transport.close();
    await vi.waitFor(() => expect(torMocks.closeClient).toHaveBeenCalled());
  });

  it('passes the chosen bridge straight through to the bootstrap', async () => {
    const transport = new AnonymousSignalingTransport({ bridge: 'webrtc' });
    await transport.waitUntilReady();

    expect(torMocks.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ bridge: 'webrtc' }),
    );
    transport.close();
  });

  it('closes sockets that are still connecting when the transport closes', async () => {
    // The relay pool only closes OPEN sockets; one mid-rendezvous at session
    // end is the transport's to cancel, and it must not surface as an error.
    let rejectConnect: (error: Error) => void = () => {};
    torMocks.client.connectWebSocket.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectConnect = reject;
        }),
    );
    const transport = new AnonymousSignalingTransport({ bridge: 'websocket' });
    await transport.waitUntilReady();

    const socket = new transport.websocketImplementation(RELAY);
    const errors: string[] = [];
    socket.addEventListener('error', (event) =>
      errors.push((event as ErrorEvent).message),
    );
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener(
        'close',
        (event) => resolve(event as CloseEvent),
        {
          once: true,
        },
      ),
    );
    await vi.waitFor(() =>
      expect(torMocks.client.connectWebSocket).toHaveBeenCalledWith(RELAY),
    );

    transport.close();
    expect(socket.readyState).toBe(2 /* CLOSING */);
    // webtor aborts the in-flight connect once the client is closed.
    rejectConnect(new Error('Tor client closed while connecting'));

    await closed;
    expect(socket.readyState).toBe(3 /* CLOSED */);
    expect(errors).toEqual([]);
    expect(torMocks.closeSocket).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(torMocks.closeClient).toHaveBeenCalled());
  });

  it('rejects non-text Nostr messages', async () => {
    const transport = new AnonymousSignalingTransport({ bridge: 'websocket' });
    await transport.waitUntilReady();
    const socket = new transport.websocketImplementation(RELAY);
    await new Promise<void>((resolve) =>
      socket.addEventListener('open', () => resolve(), { once: true }),
    );

    expect(() => socket.send(new Uint8Array([1, 2, 3]))).toThrow(
      'Nostr signaling only supports text messages',
    );
    transport.close();
  });

  it('fails instead of waiting forever when the bootstrap stalls', async () => {
    vi.useFakeTimers();
    try {
      torMocks.bootstrap.mockImplementationOnce(() => new Promise(() => {}));
      const transport = new AnonymousSignalingTransport({
        bridge: 'websocket',
      });
      const failure = expect(transport.waitUntilReady()).rejects.toThrow(
        'Anonymous signaling could not reach the Tor network within 5 minutes',
      );

      await vi.advanceTimersByTimeAsync(300_000);
      await failure;
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a client that finishes bootstrapping after the session ended', async () => {
    // Cancelling during a five-minute bootstrap is the common case, and a
    // client that lands afterwards would otherwise hold circuits for nobody.
    let finishBootstrap: (client: typeof torMocks.client) => void = () => {};
    torMocks.bootstrap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBootstrap = resolve;
        }),
    );
    const transport = new AnonymousSignalingTransport({ bridge: 'websocket' });
    const failure = expect(transport.waitUntilReady()).rejects.toThrow(
      'Anonymous signaling was cancelled',
    );

    transport.close();
    finishBootstrap(torMocks.client);

    await failure;
    await vi.waitFor(() => expect(torMocks.closeClient).toHaveBeenCalled());
  });
});
