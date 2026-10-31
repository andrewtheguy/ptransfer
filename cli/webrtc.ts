import type { PeerConnectionClass } from '@/lib/webrtc';

/**
 * SCTP send and receive buffers for every connection libdatachannel makes.
 * Its defaults keep about a megabyte in flight, and a connection can move no
 * more than that per round trip: under 6 MiB/s at 50 ms or at 100 ms. 8 MiB
 * lets the same connections carry 45 and 31 MiB/s, and larger buffers did
 * worse, overrunning the UDP socket buffers in bursts and losing packets.
 */
const SCTP_BUFFER_BYTES = 8 * 1024 * 1024;

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
  const [{ RTCPeerConnection }, { setSctpSettings }] = await Promise.all([
    import('node-datachannel/polyfill'),
    import('node-datachannel'),
  ]);
  // Process-wide, and read when a connection is made, so it is set before
  // the caller can make one.
  setSctpSettings({
    recvBufferSize: SCTP_BUFFER_BYTES,
    sendBufferSize: SCTP_BUFFER_BYTES,
  });
  // The polyfill's declarations are written against lib.dom, which this
  // build leaves out on purpose, so they do not line up with the interfaces
  // in lib.webrtc.d.ts that stand in for it; the class implements the W3C
  // interface either way.
  return RTCPeerConnection as unknown as PeerConnectionClass;
}
