import type { DuplexChannel } from '@/lib/duplex-channel';
import { cancelOverLink } from '@/lib/p2p-transfer';
import type { WebRTCConnection } from '@/lib/webrtc';

/**
 * How long a peer connection stays up once a cancel has told the receiver.
 * Closing it in the same tick as the send can tear the transport down before
 * the message leaves.
 */
const HANG_UP_GRACE_MS = 500;

/**
 * How long a sender keeps the peer connection up after its last byte left
 * its buffer, when the receiver has not hung up yet. The receiver closes as
 * soon as it has the file, so this is normally over within a round trip; the
 * bound covers a receiver that never does.
 */
export const SENT_LINGER_MS = 10_000;

/**
 * Close a cancelled send's peer connection — telling the receiver first, when
 * a transfer is running on it, so the receiver stops at once with "cancelled"
 * rather than reporting a connection that dropped. For a sender's cancel
 * only: a transfer that finished or failed has already said what happened,
 * and a receiver has nothing to say but the close itself.
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

/**
 * Hold a finished send's channel open until the receiver hangs up, the
 * sender's user cancels, or `timeoutMs` passes. The bytes have left this
 * side's buffer, not this machine: closing at once could cut off what the
 * transport is still delivering.
 */
export function lingerAfterSend(
  channel: DuplexChannel,
  isCancelled: () => boolean,
  timeoutMs: number = SENT_LINGER_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let unwatch = () => {};
    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      unwatch();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const poll = setInterval(() => {
      if (isCancelled()) finish();
    }, 250);
    // A channel that has already ended calls back at once.
    unwatch = channel.onEnd(finish);
  });
}
