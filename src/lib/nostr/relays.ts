// Relays used for signaling (both sender and receiver must use the same list)
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.rocks',
  'wss://relay.nostr.pub',
  'wss://relay.snort.social',
] as const;

export const MIN_CONNECTED_RELAYS = 2;
