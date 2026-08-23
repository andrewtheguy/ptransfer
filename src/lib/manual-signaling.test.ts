import { describe, expect, it } from 'vitest';
import {
  estimatePayloadSize,
  generateMutualAnswerBinary,
  generateMutualClipboardData,
  generateMutualOfferBinary,
  generateNostrFilePayloadBinary,
  isMutualPayload,
  isValidNostrFileLivePayload,
  isValidSignalingPayload,
  type NostrFileLivePayload,
  parseAnyManualPayload,
  parseClipboardPayload,
  parseMutualPayload,
  type SignalingPayload,
} from './manual-signaling';

describe('Manual Signaling Utils', () => {
  const mockOffer: RTCSessionDescriptionInit = {
    type: 'offer',
    sdp: 'v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 1 RTP/AVP 111\r\nc=IN IP4 127.0.0.1',
  };
  const mockCandidates: RTCIceCandidate[] = [
    {
      candidate: 'candidate:1 1 UDP 123 127.0.0.1 12345 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    } as RTCIceCandidate,
  ];
  const mockPublicKey = new Uint8Array(65).fill(1);
  mockPublicKey[0] = 4; // Uncompressed point prefix
  const mockSalt = new Uint8Array(16).fill(2);

  it('should generate and parse mutual offer binary correctly', async () => {
    const metadata = {
      createdAt: Date.now(),
      fileName: 'test.txt',
      fileSize: 1024,
      contentEncoding: 'deflate-raw' as const,
      mimeType: 'text/plain',
      publicKey: mockPublicKey,
      salt: mockSalt,
    };

    const binary = await generateMutualOfferBinary(
      mockOffer,
      mockCandidates,
      metadata,
    );

    expect(isMutualPayload(binary)).toBe(true);
    expect(Array.from(binary.subarray(0, 4))).toEqual([0x50, 0x54, 0x30, 0x31]);
    expect(binary.length).toBeGreaterThan(8); // Header + something

    const parsed = await parseMutualPayload(binary);

    expect(parsed).toBeDefined();
    expect(parsed?.type).toBe('offer');
    expect(parsed?.sdp).toBe(mockOffer.sdp);
    expect(parsed?.candidates).toHaveLength(1);
    expect(parsed?.candidates[0]).toBe(mockCandidates[0].candidate);
    expect(parsed?.fileName).toBe(metadata.fileName);
    expect(parsed?.contentEncoding).toBe(metadata.contentEncoding);
    expect(parsed?.publicKey).toEqual(Array.from(mockPublicKey));
  });

  it('should generate and parse mutual answer binary correctly', async () => {
    const createdAt = Date.now();
    const binary = await generateMutualAnswerBinary(
      { type: 'answer', sdp: mockOffer.sdp },
      mockCandidates,
      mockPublicKey,
      createdAt,
    );

    expect(isMutualPayload(binary)).toBe(true);

    const parsed = await parseMutualPayload(binary);
    expect(parsed).toBeDefined();
    expect(parsed?.type).toBe('answer');
    expect(parsed?.sdp).toBe(mockOffer.sdp);
    expect(parsed?.publicKey).toEqual(Array.from(mockPublicKey));
  });

  it('should obfuscate data (output should not contain cleartext JSON)', async () => {
    const metadata = {
      createdAt: Date.now(),
      publicKey: mockPublicKey,
      salt: mockSalt,
      fileName: 'secret-file-name.txt',
      fileSize: 100,
      contentEncoding: 'deflate-raw' as const,
      mimeType: 'text/plain',
    };

    const binary = await generateMutualOfferBinary(mockOffer, [], metadata);
    const decoder = new TextDecoder();
    const binaryString = decoder.decode(binary);

    // The filename should NOT be visible in the binary string because of compression + obfuscation
    expect(binaryString).not.toContain('secret-file-name.txt');
  });

  it('should validate signaling payload structure', () => {
    const validPayload = {
      type: 'offer',
      sdp: 'sdp',
      candidates: ['cand1'],
      createdAt: 123456,
      publicKey: Array.from(mockPublicKey), // array of numbers
    };
    expect(isValidSignalingPayload(validPayload)).toBe(true);

    const invalidPayload = { ...validPayload, type: 'invalid' };
    expect(isValidSignalingPayload(invalidPayload)).toBe(false);

    const missingKey = { ...validPayload, publicKey: undefined };
    expect(isValidSignalingPayload(missingKey)).toBe(false);

    const nonFiniteCreatedAt = {
      ...validPayload,
      createdAt: Number.POSITIVE_INFINITY,
    };
    expect(isValidSignalingPayload(nonFiniteCreatedAt)).toBe(false);
  });

  it('should handle clipboard base64 conversions', () => {
    const binary = new Uint8Array([1, 2, 3, 4, 5]);
    const base64 = generateMutualClipboardData(binary);

    expect(typeof base64).toBe('string');

    const parsed = parseClipboardPayload(base64);
    expect(parsed).toEqual(binary);
  });

  it('should return null for invalid binary payload', async () => {
    const invalidBinary = new Uint8Array([0, 0, 0, 0, 1, 2, 3]);
    expect(isMutualPayload(invalidBinary)).toBe(false);
    expect(await parseMutualPayload(invalidBinary)).toBeNull();
  });

  it('should estimate payload size', async () => {
    const payload: SignalingPayload = {
      type: 'offer',
      sdp: 'sdp',
      candidates: [],
      createdAt: Date.now(),
      publicKey: Array.from(mockPublicKey),
    };
    const size = await estimatePayloadSize(payload);
    expect(size).toBeGreaterThan(0);
  });
});

describe('Nostr file payload', () => {
  const mockOffer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0' };
  const mockCandidates: RTCIceCandidate[] = [];
  const mockPublicKey = new Uint8Array(65).fill(1);
  mockPublicKey[0] = 4;
  const mockSalt = new Uint8Array(16).fill(2);
  const createdAt = Math.floor(Date.now() / 1000);
  const validPayload: NostrFileLivePayload = {
    type: 'nostr-file-live',
    v: 6,
    fileName: 'photo.jpg',
    fileSize: 5 * 1024 * 1024,
    mimeType: 'image/jpeg',
    fileHash: `${'B'.repeat(43)}=`,
    transferId: 'a'.repeat(32),
    pubkey: 'c'.repeat(64),
    compression: 'none',
    payloadSize: 5 * 1024 * 1024,
    chunkSize: 32768,
    totalChunks: Math.ceil((5 * 1024 * 1024) / 32768),
    enc: 2,
    controlRelays: ['wss://relay.one', 'wss://relay.two'],
    createdAt,
    expiresAt: createdAt + 3600,
    key: `${'K'.repeat(43)}=`,
  };

  it('round-trips through the PT01 container', () => {
    const binary = generateNostrFilePayloadBinary(validPayload);
    expect(isMutualPayload(binary)).toBe(true);
    const parsed = parseAnyManualPayload(binary);
    expect(parsed?.kind).toBe('nostr-file-live');
    expect(parsed?.payload).toEqual(validPayload);
    // A nostr-file payload is not a signaling payload.
    expect(parseMutualPayload(binary)).toBeNull();
  });

  it('encodes a 3200-chunk manifest into a single-QR-frame payload', () => {
    const large: NostrFileLivePayload = {
      ...validPayload,
      fileSize: 100 * 1024 * 1024,
      payloadSize: 100 * 1024 * 1024,
      totalChunks: 3200,
      controlRelays: [
        'wss://relay.example-one.com',
        'wss://relay.example-two.net',
        'wss://relay.example-three.io',
        'wss://relay.example-four.org',
      ],
    };
    const binary = generateNostrFilePayloadBinary(large);
    // Without the 16-relay ring (it travels over the control channel now)
    // the payload fits one ~400-byte QR frame with headroom.
    const ONE_QR_CAPACITY_BYTES = 400;
    expect(binary.length).toBeLessThan(ONE_QR_CAPACITY_BYTES);
  });

  it('discriminates all payload types', () => {
    const offerBinary = generateMutualOfferBinary(mockOffer, mockCandidates, {
      createdAt: Date.now(),
      fileName: 'a.txt',
      fileSize: 1,
      contentEncoding: 'deflate-raw' as const,
      mimeType: 'text/plain',
      publicKey: mockPublicKey,
      salt: mockSalt,
    });
    expect(parseAnyManualPayload(offerBinary)?.kind).toBe('signaling');

    const nostrBinary = generateNostrFilePayloadBinary(validPayload);
    expect(parseAnyManualPayload(nostrBinary)?.kind).toBe('nostr-file-live');

    expect(parseAnyManualPayload(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    // A nostr-file payload is not a signaling payload.
    expect(parseMutualPayload(nostrBinary)).toBeNull();
  });

  it('rejects malformed nostr-file payloads', () => {
    expect(isValidNostrFileLivePayload(validPayload)).toBe(true);
    expect(isValidNostrFileLivePayload({ ...validPayload, key: 'short' })).toBe(
      false,
    );
    expect(
      isValidNostrFileLivePayload({
        ...validPayload,
        fileSize: 101 * 1024 * 1024,
        payloadSize: 101 * 1024 * 1024,
        totalChunks: Math.ceil((101 * 1024 * 1024) / 32768),
      }),
    ).toBe(false);
    expect(
      isValidNostrFileLivePayload({ ...validPayload, totalChunks: 3 }),
    ).toBe(false);
    expect(
      isValidNostrFileLivePayload({ ...validPayload, transferId: 'zz' }),
    ).toBe(false);
    expect(
      isValidNostrFileLivePayload({ ...validPayload, controlRelays: [] }),
    ).toBe(false);
    expect(
      isValidNostrFileLivePayload({
        ...validPayload,
        controlRelays: ['http://not-wss.example', 'wss://relay.one'],
      }),
    ).toBe(false);
    expect(
      isValidNostrFileLivePayload({
        ...validPayload,
        expiresAt: validPayload.createdAt + 7200,
      }),
    ).toBe(false);
    expect(
      isValidNostrFileLivePayload({ ...validPayload, type: 'offer' }),
    ).toBe(false);
    expect(isValidNostrFileLivePayload({ ...validPayload, v: 5 })).toBe(false);
    expect(isValidNostrFileLivePayload({ ...validPayload, enc: 1 })).toBe(
      false,
    );
    expect(
      isValidNostrFileLivePayload({ ...validPayload, pubkey: 'Z'.repeat(64) }),
    ).toBe(false);
    expect(
      isValidNostrFileLivePayload({
        ...validPayload,
        fileHash: 'not base64!!',
      }),
    ).toBe(false);
    expect(
      isValidNostrFileLivePayload({ ...validPayload, chunkSize: 100 }),
    ).toBe(false);
  });
});
