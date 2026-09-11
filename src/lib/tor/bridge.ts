import { getStunUrls } from '@/lib/stun';
import type { RtcPeerConnectionClass, WebtorClientOptions } from './webtor-api';

/**
 * Which Snowflake bridge a Tor client enters the network through, and the
 * `WebtorClient.create` options that choice comes down to. Shared by the
 * browser (`./client.ts`) and the CLI (`cli/tor/bootstrap.ts`), so nothing
 * here touches a platform API.
 */

/**
 * How a client reaches its Snowflake bridge.
 *
 * - `websocket` opens a direct WebSocket to one fixed bridge endpoint: no
 *   broker, no volunteer proxy, no STUN. Fewer moving parts, and the faster of
 *   the two, but a network that blocks that endpoint blocks the transfer.
 * - `webrtc` goes through a volunteer proxy brokered over HTTPS, which is what
 *   Snowflake is designed for and much harder to block — at the cost of
 *   needing STUN and a proxy being available.
 */
export type TorBridge = 'websocket' | 'webrtc';

export const TOR_BRIDGES: readonly TorBridge[] = ['websocket', 'webrtc'];

export const DEFAULT_TOR_BRIDGE: TorBridge = 'websocket';

/** Labels for the bridge choice, used wherever it is offered. */
export const TOR_BRIDGE_LABELS: Record<TorBridge, string> = {
  websocket: 'Snowflake WebSocket',
  webrtc: 'Snowflake WebRTC',
};

/**
 * A websocket bridge to use instead of the public one. Both halves or neither:
 * a URL without an identity would be a request to trust whatever answers.
 */
export interface CustomBridge {
  url: string;
  fingerprint: string;
}

/**
 * Everything one bridge choice takes. A custom bridge exists only for
 * `websocket`, since `webrtc` reaches the public bridge through whichever
 * volunteer proxy the broker picks. `webrtc` always names the
 * `RTCPeerConnection` it runs on: the tab's own, or the CLI's
 * node-datachannel.
 */
export type BridgeSetup =
  | { bridge: 'websocket'; custom?: CustomBridge }
  | { bridge: 'webrtc'; rtcPeerConnection: RtcPeerConnectionClass };

/**
 * The `WebtorClient.create` options for `setup`. The `webrtc` bridge always
 * gets the STUN servers the rest of the app's WebRTC uses.
 */
export function bridgeOptions(setup: BridgeSetup): WebtorClientOptions {
  if (setup.bridge === 'webrtc') {
    return {
      bridge: 'webrtc',
      stunUrls: getStunUrls(),
      rtcPeerConnection: setup.rtcPeerConnection,
    };
  }
  return {
    bridge: 'websocket',
    ...(setup.custom
      ? {
          bridgeUrl: setup.custom.url,
          bridgeFingerprint: setup.custom.fingerprint,
        }
      : {}),
  };
}
