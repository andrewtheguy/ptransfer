/**
 * The Tor client's bootstrap progress, held for whoever wants it later.
 *
 * A fallback that runs through Tor starts its client long before it knows it
 * will need one: the bootstrap is minutes, so it runs behind the exchange and
 * the direct attempt. While those are on screen its progress has no place
 * there. Once the fallback is waiting on the bootstrap it is the only progress
 * there is, so the fallback reads the latest line and follows the rest.
 */
export interface TorProgress {
  /** The most recent status line, or '' before the first. */
  latest(): string;
  /**
   * Hand every later line to `listener` until the returned function is
   * called. One follower at a time: a new one replaces the last.
   */
  follow(listener: (message: string) => void): () => void;
}

export interface TorProgressFeed extends TorProgress {
  /** Record a status line from the Tor client. */
  push(message: string): void;
}

export function createTorProgress(): TorProgressFeed {
  let latest = '';
  let follower: ((message: string) => void) | null = null;
  return {
    latest: () => latest,
    follow(listener) {
      follower = listener;
      return () => {
        if (follower === listener) follower = null;
      };
    },
    push(message) {
      latest = message;
      follower?.(message);
    },
  };
}
