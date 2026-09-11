import type { PeerConnectionClass } from '@/lib/webrtc';

/**
 * The `RTCPeerConnection` Bun does not have: node-datachannel's W3C polyfill
 * over libdatachannel. Code Exchange connects over it, and the Snowflake
 * `webrtc` bridge reaches the Tor network over it, handed to the Tor client
 * as `rtcPeerConnection`. Either way it is passed to whoever needs it, which
 * is how the shared code and webtor take every implementation, the tab's own
 * included; nothing is installed as a global.
 *
 * Imported only when one of those is chosen: it is a native addon, and a
 * command that uses neither has no use for it, nor any reason to fail on a
 * machine where it does not load.
 */
export async function loadRtcPeerConnection(): Promise<PeerConnectionClass> {
  const { RTCPeerConnection } = await import('node-datachannel/polyfill');
  // The polyfill's declarations are written against lib.dom, which this
  // build leaves out on purpose, so they do not line up with the interfaces
  // in lib.webrtc.d.ts that stand in for it; the class implements the W3C
  // interface either way.
  return RTCPeerConnection as unknown as PeerConnectionClass;
}
