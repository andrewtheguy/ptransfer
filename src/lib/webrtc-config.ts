import { getStunUrls } from './stun';

/**
 * WebRTC ICE Server Configuration
 *
 * Uses the public STUN servers in `./stun.ts` for direct ICE candidate
 * discovery. TURN is intentionally unsupported, so WebRTC itself uses direct
 * candidates only. PIN Exchange fails when no direct route can be established;
 * Code Exchange may switch to its separate Nostr file-relay fallback.
 */

/**
 * Get the complete ICE server configuration.
 * Includes STUN servers only; no relay candidates are configured.
 */
export function getIceServers(): RTCIceServer[] {
  return getStunUrls().map((urls) => ({ urls }));
}

/**
 * Get complete RTCConfiguration with ICE servers.
 * Use this when creating a new RTCPeerConnection.
 */
export function getWebRTCConfig(): RTCConfiguration {
  return {
    iceServers: getIceServers(),
    // Use all available candidates for best connectivity
    iceCandidatePoolSize: 10,
  };
}
