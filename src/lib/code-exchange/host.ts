import type { AppendSink } from '@/lib/append-sink';
import type { TransferMetadata } from '@/lib/nostr';
import type { RelayPoolStorage } from '@/lib/nostr-file/relay-pool';
import type { PeerConnectionClass } from '@/lib/webrtc';

/**
 * What a Code Exchange session takes from the program running it: the three
 * things the browser tab (`browser-host.ts`) and the CLI (`cli/code/host.ts`)
 * provide differently. Everything else a session does is the same code on
 * both, which is what lets either end of a transfer be a tab or a terminal.
 */
export interface ExchangeHost {
  /** The `RTCPeerConnection` both directions connect with. */
  readonly peerConnection: PeerConnectionClass;
  /** The relay cache a sender's clearnet fallback reads and keeps current. */
  relayStorage(): RelayPoolStorage;
  /**
   * Where a received file is written as it arrives, over the direct route
   * or the Tor fallback. The sink's finished blob is the received payload,
   * and a transfer that is abandoned discards it.
   */
  createSink(metadata: TransferMetadata): Promise<AppendSink>;
}
