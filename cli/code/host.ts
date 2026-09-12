import type { AppendSink } from '@/lib/append-sink';
import type { ExchangeHost } from '@/lib/code-exchange/host';
import type { FallbackReceipt } from '@/lib/code-exchange/receive';
import { createFileSink } from '../transfer/files';
import { loadRtcPeerConnection } from '../webrtc';
import { openRelayStore } from './relay-store';

/**
 * The CLI as a Code Exchange host: node-datachannel's `RTCPeerConnection`,
 * the relay cache in a file under the cache directory, and a received file
 * written to a part file beside its destination that takes the destination's
 * name once the transfer checks out. The browser tab's counterpart is
 * `src/lib/code-exchange/browser-host.ts`.
 */
export interface CliExchangeHost extends ExchangeHost {
  /**
   * Discard every sink this host made that has not finished — the part file
   * of a transfer that is being abandoned, whichever route it was on.
   */
  abandon(): Promise<void>;
}

export async function createCliHost(options: {
  cacheDir: string;
  /** Where a received file is saved; null for a side that only sends. */
  destination: string | null;
}): Promise<CliExchangeHost> {
  const peerConnection = await loadRtcPeerConnection();
  const unfinished = new Set<AppendSink>();

  return {
    peerConnection,
    relayStorage: () => openRelayStore(options.cacheDir),
    async createSink() {
      if (options.destination === null) {
        throw new Error('A sending side has nowhere to save a file');
      }
      const sink = await createFileSink(options.destination);
      unfinished.add(sink);
      return {
        append: (bytes) => sink.append(bytes),
        async finish() {
          const payload = await sink.finish();
          unfinished.delete(sink);
          return payload;
        },
        async discard() {
          unfinished.delete(sink);
          await sink.discard();
        },
      };
    },
    async abandon() {
      const sinks = [...unfinished];
      unfinished.clear();
      await Promise.all(
        sinks.map((sink) => sink.discard().catch(() => undefined)),
      );
    },
  };
}

/**
 * The bytes a fallback saved. The Tor fallback writes through the host's sink,
 * so its file is already in place; the relay fallback hands back what it
 * reassembled in memory, which is written out here the same way.
 */
export async function savedFrom(
  receipt: FallbackReceipt | 'switched' | null,
  host: CliExchangeHost,
): Promise<number> {
  if (receipt === null || receipt === 'switched') throw new Error('Cancelled');
  if (receipt.sink) return receipt.content.data.size;
  const { fileName, fileSize, mimeType } = receipt.content;
  const sink = await host.createSink({
    contentType: 'file',
    fileName,
    fileSize,
    contentEncoding: 'identity',
    mimeType,
  });
  try {
    await sink.append(new Uint8Array(await receipt.content.data.arrayBuffer()));
    return (await sink.finish()).size;
  } catch (error) {
    await sink.discard();
    throw error;
  }
}
