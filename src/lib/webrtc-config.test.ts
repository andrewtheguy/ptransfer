import { describe, expect, it } from 'vitest';
import { getIceServers, getStunUrls, getWebRTCConfig } from './webrtc-config';

describe('WebRTC configuration', () => {
  it('configures STUN discovery without TURN relay fallback', () => {
    const servers = getIceServers();

    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      expect(urls.every((url) => url.startsWith('stun:'))).toBe(true);
    }

    expect(getWebRTCConfig().iceServers).toEqual(servers);
    expect(getStunUrls()).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ]);
  });
});
