import { generateEphemeralKeys } from '../nostr/events';
import {
  type ControlChannel,
  deriveControlKey,
  openControlChannel,
  parseReceiverMessage,
} from './control';
import type { NostrFilePool } from './pool';
import type { RelaySession } from './session';
import type { NostrFileTransferStats } from './stats';

export interface ReceiverHelloWatch {
  /**
   * Resolves once the receiver's sealed `hello` has been read from the
   * control relays. Never rejects; it simply stays pending after `close()`.
   */
  hello: Promise<void>;
  close(): void;
}

/**
 * Listen on the control relays for the receiver's `hello` while the direct
 * WebRTC attempt is still running.
 *
 * The receiver only opens its control channel after its own ICE agent has
 * declared the direct route dead, which it does long before the sender's
 * agent (the offerer keeps real candidates to try against the receiver's
 * unreachable ones). Its `hello` is therefore the earliest possible signal
 * that no direct connection is coming: seeing it lets the sender abandon
 * the direct attempt at once instead of riding out
 * `RELAY_FALLBACK_ATTEMPT_TIMEOUT_MS`. Only the holder of the shared secret
 * can seal a message under the session's control key, so a bystander cannot
 * knock the sender off the direct path.
 *
 * The session's key bytes are only read to derive the (non-extractable)
 * control key; ownership stays with the caller.
 */
export function watchForReceiverHello(
  pool: NostrFilePool,
  controlRelays: string[],
  session: RelaySession,
  opts: {
    /** unix seconds: the exchange's start, so an earlier hello is read from the backlog */
    since: number;
    /** unix seconds: the exchange's deadline */
    expiresAt: number;
    stats?: NostrFileTransferStats;
  },
): ReceiverHelloWatch {
  let closed = false;
  let channel: ControlChannel | null = null;
  let resolveHello: () => void = () => {};
  const hello = new Promise<void>((resolve) => {
    resolveHello = resolve;
  });

  const close = () => {
    if (closed) return;
    closed = true;
    channel?.close();
    channel = null;
  };

  void (async () => {
    const key = await deriveControlKey(session.keyBytes, session.transferId);
    if (closed) return;
    const { secretKey, publicKey } = generateEphemeralKeys();
    channel = openControlChannel(pool, controlRelays, {
      transferId: session.transferId,
      key,
      role: 'sender',
      secretKey,
      since: opts.since,
      expiresAt: opts.expiresAt,
      stats: opts.stats,
      onMessage: (raw, pubkey) => {
        if (closed || pubkey === publicKey) return;
        // Chunk-bound fields are irrelevant here: only `hello` counts.
        const msg = parseReceiverMessage(raw, 0, 0);
        if (msg?.t !== 'hello') return;
        resolveHello();
        close();
      },
    });
  })();

  return { hello, close };
}
