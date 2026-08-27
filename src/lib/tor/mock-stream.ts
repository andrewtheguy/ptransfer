import type { OnionStream } from './webtor';

/**
 * An in-memory pair of `OnionStream`s wired to each other, for exercising the
 * framing, handshake and transfer without a Tor circuit.
 *
 * It reproduces the two properties of a real onion stream those layers have to
 * cope with: bytes arrive in whatever pieces the writer produced (a reader can
 * never assume a frame arrives whole), and a close is delivered as a `null`
 * from `receive()` rather than as an error.
 *
 * Mirrors `mock-pool.ts` for the Nostr side: production code never imports it,
 * but it lives beside what it stands in for.
 */

interface Pipe {
  chunks: Uint8Array[];
  waiting: ((value: Uint8Array | null) => void)[];
  closed: boolean;
}

function createPipe(): Pipe {
  return { chunks: [], waiting: [], closed: false };
}

function push(pipe: Pipe, data: Uint8Array): void {
  const waiter = pipe.waiting.shift();
  if (waiter) waiter(data);
  else pipe.chunks.push(data);
}

function closePipe(pipe: Pipe): void {
  pipe.closed = true;
  for (const waiter of pipe.waiting.splice(0)) waiter(null);
}

function receive(pipe: Pipe): Promise<Uint8Array | null> {
  const chunk = pipe.chunks.shift();
  if (chunk) return Promise.resolve(chunk);
  if (pipe.closed) return Promise.resolve(null);
  return new Promise((resolve) => pipe.waiting.push(resolve));
}

function endpoint(inbound: Pipe, outbound: Pipe): OnionStream {
  return {
    sendBytes(payload: Uint8Array) {
      if (outbound.closed) {
        return Promise.reject(new Error('The stream is closed'));
      }
      // Copy: the caller reuses its frame buffer, exactly as the WASM binding
      // does not.
      push(outbound, payload.slice());
      return Promise.resolve(undefined);
    },
    send(text: string) {
      return this.sendBytes(new TextEncoder().encode(text));
    },
    receive: () => receive(inbound),
    close() {
      // Closing either half ends the conversation both ways, which is what an
      // END cell does.
      closePipe(outbound);
      closePipe(inbound);
      return Promise.resolve(undefined);
    },
  };
}

/** Two connected endpoints: what one sends, the other receives. */
export function createOnionStreamPair(): [OnionStream, OnionStream] {
  const toB = createPipe();
  const toA = createPipe();
  return [endpoint(toA, toB), endpoint(toB, toA)];
}
