import { DEFAULT_RELAYS, normalizeRelayUrl } from './relays';

const RELAY_PROBE_TIMEOUT = 3000;

export interface RelayAvailabilityResult {
  available: boolean;
  connectedRelays: string[];
  error?: string;
}

/**
 * Simple probe - just check if relay is reachable via WebSocket
 * Closes connection immediately after success
 */
function probeRelay(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    const timeout = setTimeout(() => {
      if (ws) {
        ws.close();
      }
      resolve(null);
    }, RELAY_PROBE_TIMEOUT);

    try {
      ws = new WebSocket(url);
      ws.onopen = () => {
        clearTimeout(timeout);
        ws?.close();
        resolve(url);
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        resolve(null);
      };
    } catch {
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

/**
 * Test Nostr relay availability by attempting WebSocket connections.
 * Probes all relays in parallel and returns which ones are available.
 *
 * @param relays - Relay URLs to test (defaults to DEFAULT_RELAYS)
 */
export async function testRelayAvailability(
  relays: string[] = [...DEFAULT_RELAYS],
): Promise<RelayAvailabilityResult> {
  try {
    const canonicalRelays = [
      ...new Set(
        relays
          .map(normalizeRelayUrl)
          .filter((url): url is string => url !== null),
      ),
    ];
    const results = await Promise.all(
      canonicalRelays.map((url) => probeRelay(url)),
    );
    const connectedRelays = results.filter((r): r is string => r !== null);

    return {
      available: connectedRelays.length > 0,
      connectedRelays,
    };
  } catch (error) {
    return {
      available: false,
      connectedRelays: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
