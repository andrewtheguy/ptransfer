import {
  ANONYMOUS_SIGNALING_RELAYS,
  createNostrClient,
  DEFAULT_RELAYS,
  type NostrClient,
} from '@/lib/nostr';
import type { AnonymousSignalingTransport } from '@/lib/nostr/anonymous-transport';

/**
 * Where a PIN Exchange handshake is carried, and the wait for it to be
 * carryable.
 *
 * The two relay pools are disjoint and the PIN's length is what tells the
 * receiver which one its sender is on, so the pool and the PIN's kind are
 * decided together and never separately. Both hosts open them the same way;
 * what differs is only how each one starts a Tor client, which is why the
 * transport is handed in rather than made here.
 */

/** The relays a PIN of this kind is published on and looked for on. */
export function pinSignalingRelays(anonymous: boolean): readonly string[] {
  return anonymous ? ANONYMOUS_SIGNALING_RELAYS : DEFAULT_RELAYS;
}

export interface PinSignalingOptions {
  anonymous: boolean;
  /** The Tor client's transport for an anonymous handshake; null otherwise. */
  transport: AnonymousSignalingTransport | null;
  isCancelled: () => boolean;
  report: (message: string) => void;
  /**
   * Called once the Tor client is up, before the onion relay sockets open —
   * the moment the bootstrap stops being the only thing worth showing.
   */
  onTorUp?: () => void;
}

/**
 * Open the signaling client for a PIN of this kind, connected and ready to
 * publish. Null once the caller has cancelled.
 *
 * The client is the caller's to close; the transport behind an anonymous one
 * is not, since the same Tor client also carries the transfer's fallback.
 */
export async function openPinSignaling(
  options: PinSignalingOptions,
): Promise<NostrClient | null> {
  const { anonymous, transport, isCancelled, report } = options;
  report(
    anonymous
      ? 'Starting the Tor client for anonymous signaling...'
      : 'Connecting to relays...',
  );
  const client = createNostrClient(
    [...pinSignalingRelays(anonymous)],
    transport ? { anonymousTransport: transport } : {},
  );
  try {
    if (anonymous) {
      await client.waitForAnonymousTransport();
      options.onTorUp?.();
      if (isCancelled()) {
        client.close();
        return null;
      }
      report('Tor is up. Opening onion relay connections...');
    }
    await client.waitForConnection();
    if (isCancelled()) {
      client.close();
      return null;
    }
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
