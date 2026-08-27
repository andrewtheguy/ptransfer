/**
 * WebRTC ICE Server Configuration
 *
 * Provides multiple public STUN servers for direct ICE candidate discovery.
 * TURN is intentionally unsupported, so WebRTC itself uses direct candidates
 * only. PIN Exchange fails when no direct route can be established; Code
 * Exchange may switch to its separate Nostr file-relay fallback.
 */

/**
 * Public STUN servers for NAT traversal.
 * Multiple servers provide redundancy if one is unavailable.
 */
const STUN_SERVERS: RTCIceServer[] = [
  // Google STUN servers (highly reliable)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Cloudflare STUN
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * Get the complete ICE server configuration.
 * Includes STUN servers only; no relay candidates are configured.
 */
export function getIceServers(): RTCIceServer[] {
  return [...STUN_SERVERS];
}

/**
 * The STUN servers as bare URLs, for consumers that take a plain list rather
 * than an RTCIceServer — the Snowflake `webrtc` bridge of the browser Tor
 * client is the one today. Same servers as ICE uses, so a network that allows
 * one allows the other.
 */
export function getStunUrls(): string[] {
  return STUN_SERVERS.flatMap((server) =>
    typeof server.urls === 'string' ? [server.urls] : [...server.urls],
  );
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
