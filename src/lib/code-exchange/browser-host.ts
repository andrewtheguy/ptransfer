import { BROWSER_MAX_TRANSFER_BYTES } from '@/lib/crypto';
import { createIndexedDbRelayPool } from '@/lib/nostr-file/relay-cache-idb';
import { createAdaptiveAppendSink } from '@/lib/scratch-sink';
import type { ExchangeHost } from './host';

/**
 * The browser tab as a Code Exchange host: the page's own
 * `RTCPeerConnection`, the relay cache in IndexedDB, and scratch storage
 * (memory, then OPFS) for what arrives until the page offers it as a
 * download.
 */
export const BROWSER_EXCHANGE_HOST: ExchangeHost = {
  // Read when a connection is made rather than when this module loads, so
  // importing it where there is no WebRTC — a unit test — is harmless.
  get peerConnection() {
    return RTCPeerConnection;
  },
  maxTransferBytes: BROWSER_MAX_TRANSFER_BYTES,
  relayStorage: createIndexedDbRelayPool,
  createSink: (metadata) => createAdaptiveAppendSink(metadata.fileSize),
};
