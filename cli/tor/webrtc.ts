import type { RtcPeerConnectionClass } from '@/lib/tor/webtor-api';

/**
 * The `RTCPeerConnection` the Snowflake `webrtc` bridge needs, which Bun does
 * not have: node-datachannel's W3C polyfill over libdatachannel. It is handed
 * to the Tor client as `rtcPeerConnection`, which is how webtor takes every
 * implementation, the tab's own included; nothing is installed as a global.
 *
 * Imported only when that bridge is chosen: it is a native addon, and a
 * `websocket` bootstrap has no use for it, nor any reason to fail on a machine
 * where it does not load.
 */
export async function loadRtcPeerConnection(): Promise<RtcPeerConnectionClass> {
  const { RTCPeerConnection } = await import('node-datachannel/polyfill');
  return RTCPeerConnection;
}
