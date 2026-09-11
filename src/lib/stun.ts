/**
 * Public STUN servers, for everything in this app that needs one: ICE for the
 * WebRTC data channel (`./webrtc-config.ts`) and the Snowflake `webrtc` bridge
 * of the Tor client. One list, so a network that allows one allows the other.
 *
 * Plain URLs with no WebRTC types, so the CLI shares the list too.
 * Multiple servers provide redundancy if one is unavailable.
 */
const STUN_URLS = [
  // Google STUN servers (highly reliable)
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  // Cloudflare STUN
  'stun:stun.cloudflare.com:3478',
];

export function getStunUrls(): string[] {
  return [...STUN_URLS];
}
