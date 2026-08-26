import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  load: vi.fn(async (): Promise<string | undefined> => 'cached-directory'),
  save: vi.fn(async () => undefined),
}));

const snapshotMocks = vi.hoisted(() => ({
  load: vi.fn(async (): Promise<string | undefined> => undefined),
}));

const wasmMocks = vi.hoisted(() => {
  const sent: string[] = [];
  const closeSocket = vi.fn(async () => undefined);
  const closeClient = vi.fn();
  let received = false;
  const socket = {
    send: vi.fn(async (text: string) => {
      sent.push(text);
    }),
    receive: vi.fn(async () => {
      if (!received) {
        received = true;
        return '["EOSE","subscription"]';
      }
      return null;
    }),
    close: closeSocket,
  };
  const client = {
    connect: vi.fn(async () => socket),
    directoryCache: vi.fn(async () => '{"version":1}'),
    close: closeClient,
  };
  return {
    client,
    closeClient,
    closeSocket,
    sent,
    init: vi.fn(async () => undefined),
    create: vi.fn(async () => client),
    reset() {
      received = false;
      sent.length = 0;
    },
  };
});

vi.mock('./tor-directory-cache', () => ({
  loadTorDirectoryCache: cacheMocks.load,
  saveTorDirectoryCache: cacheMocks.save,
}));

vi.mock('./tor-directory-snapshot', () => ({
  loadTorDirectorySnapshot: snapshotMocks.load,
}));

vi.mock('@andrewtheguy/anonymous-signaling-wasm', () => ({
  default: wasmMocks.init,
  AnonymousSignalingClient: { create: wasmMocks.create },
}));

import { AnonymousSignalingTransport } from './anonymous-websocket';

describe('AnonymousSignalingTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wasmMocks.reset();
  });

  it('adapts the WASM socket to the browser WebSocket event API', async () => {
    const transport = new AnonymousSignalingTransport({
      webSocketBridge: false,
    });
    await transport.waitUntilReady();

    const socket = new transport.websocketImplementation('wss://relay.example');
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
    expect(wasmMocks.create).toHaveBeenCalledWith(
      'cached-directory',
      [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
      ],
      false,
    );
    await vi.waitFor(() =>
      expect(cacheMocks.save).toHaveBeenCalledWith('{"version":1}'),
    );
    expect(wasmMocks.client.connect).toHaveBeenCalledWith(
      'wss://relay.example',
    );
    expect(wasmMocks.sent).toEqual(['["REQ","subscription",{}]']);

    transport.close();
    await vi.waitFor(() => expect(wasmMocks.closeClient).toHaveBeenCalled());
  });

  it('closes sockets that are still connecting when the transport closes', async () => {
    // The relay pool only closes OPEN sockets; one mid-rendezvous at session
    // end is the transport's to cancel, and it must not surface as an error.
    let rejectConnect: (error: Error) => void = () => {};
    wasmMocks.client.connect.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectConnect = reject;
        }),
    );
    const transport = new AnonymousSignalingTransport({
      webSocketBridge: true,
    });
    await transport.waitUntilReady();

    const socket = new transport.websocketImplementation('ws://relay.onion');
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
      expect(wasmMocks.client.connect).toHaveBeenCalledWith('ws://relay.onion'),
    );

    transport.close();
    expect(socket.readyState).toBe(WebSocket.CLOSING);
    // webtor aborts the in-flight connect once the client is closed.
    rejectConnect(
      new Error('Anonymous signaling client closed while connecting'),
    );

    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(errors).toEqual([]);
    expect(wasmMocks.closeSocket).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(wasmMocks.closeClient).toHaveBeenCalled());
  });

  it('seeds webtor with the served snapshot instead of the stored cache', async () => {
    snapshotMocks.load.mockResolvedValueOnce('served-snapshot');

    const transport = new AnonymousSignalingTransport({
      webSocketBridge: false,
    });
    await transport.waitUntilReady();

    expect(wasmMocks.create).toHaveBeenCalledWith(
      'served-snapshot',
      expect.any(Array),
      false,
    );
    expect(cacheMocks.load).not.toHaveBeenCalled();
    transport.close();
  });

  it('bootstraps with no directory data when neither source has any', async () => {
    cacheMocks.load.mockResolvedValueOnce(undefined);

    const transport = new AnonymousSignalingTransport({
      webSocketBridge: false,
    });
    await transport.waitUntilReady();

    // webtor downloads the consensus and its own relay sample in this case.
    expect(wasmMocks.create).toHaveBeenCalledWith(
      undefined,
      expect.any(Array),
      false,
    );
    transport.close();
  });

  it('asks webtor for the direct WebSocket bridge when requested', async () => {
    const transport = new AnonymousSignalingTransport({
      webSocketBridge: true,
    });
    await transport.waitUntilReady();

    expect(wasmMocks.create).toHaveBeenCalledWith(
      'cached-directory',
      expect.any(Array),
      true,
    );
    transport.close();
  });

  it('rejects non-text Nostr messages', async () => {
    const transport = new AnonymousSignalingTransport({
      webSocketBridge: false,
    });
    await transport.waitUntilReady();
    const socket = new transport.websocketImplementation('wss://relay.example');
    await new Promise<void>((resolve) =>
      socket.addEventListener('open', () => resolve(), { once: true }),
    );

    expect(() => socket.send(new Uint8Array([1, 2, 3]))).toThrow(
      'Nostr signaling only supports text messages',
    );
    transport.close();
  });

  it('fails instead of waiting forever when Tor initialization stalls', async () => {
    vi.useFakeTimers();
    try {
      wasmMocks.create.mockImplementationOnce(() => new Promise(() => {}));
      const transport = new AnonymousSignalingTransport({
        webSocketBridge: false,
      });
      const failure = expect(transport.waitUntilReady()).rejects.toThrow(
        'Anonymous signaling could not establish and verify Tor within 5 minutes',
      );

      await vi.advanceTimersByTimeAsync(300_000);
      await failure;
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
