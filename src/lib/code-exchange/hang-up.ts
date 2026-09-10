import type { DuplexChannel } from '@/lib/duplex-channel';
import { cancelOverLink } from '@/lib/p2p-transfer';
import type { WebRTCConnection } from '@/lib/webrtc';

/**
 * How long a peer connection stays up once a cancel has told the peer.
 * Closing it in the same tick as the send can tear the transport down before
 * the message leaves.
 */
const HANG_UP_GRACE_MS = 500;

/**
 * Close a cancelled transfer's peer connection — telling the peer first, when
 * a transfer is running on it, so the peer stops at once with "cancelled"
 * rather than reporting a connection that dropped. For a cancel only: a
 * transfer that finished or failed has already said what happened.
 */
export function hangUp(
  rtc: WebRTCConnection | null,
  channel: DuplexChannel | null,
): void {
  if (!rtc) return;
  if (channel && cancelOverLink(channel)) {
    setTimeout(() => rtc.close(), HANG_UP_GRACE_MS);
    return;
  }
  rtc.close();
}
