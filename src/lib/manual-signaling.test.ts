import { describe, expect, it } from 'vitest';
import {
  answerChannelFromOffer,
  estimatePayloadSize,
  generateMutualAnswerBinary,
  generateMutualClipboardData,
  generateMutualOfferBinary,
  isMutualPayload,
  isValidSignalingPayload,
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

describe('offer-borne answer channel', () => {
  const mockOffer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0' };
  const publicKey = new Uint8Array(65).fill(1);
  publicKey[0] = 4;
  const salt = new Uint8Array(16).fill(2);
  const secret = new Uint8Array(32).fill(3);
  const relays = ['wss://r1.example', 'wss://r2.example'];
  const metadata = {
    createdAt: Date.now(),
    fileName: 'test.txt',
    fileSize: 1024,
    contentEncoding: 'deflate-raw' as const,
    mimeType: 'text/plain',
    publicKey,
    salt,
  };

  it('round-trips the relays and secret an offer advertises', () => {
    const binary = generateMutualOfferBinary(mockOffer, [], {
      ...metadata,
      answerRelays: relays,
      answerSecret: secret,
    });
    const parsed = parseMutualPayload(binary);
    expect(parsed).not.toBeNull();
    const channel = answerChannelFromOffer(parsed as SignalingPayload);
    expect(channel?.relays).toEqual(relays);
    expect(channel?.secret).toEqual(secret);
  });

  it('advertises no channel when relays were not proven', () => {
    const binary = generateMutualOfferBinary(mockOffer, [], metadata);
    const parsed = parseMutualPayload(binary) as SignalingPayload;
    expect(parsed.answerRelays).toBeUndefined();
    expect(parsed.answerSecret).toBeUndefined();
    expect(answerChannelFromOffer(parsed)).toBeNull();
  });

  it('rejects half-formed or misplaced channel fields', () => {
    const base = {
      type: 'offer',
      sdp: 'sdp',
      candidates: [],
      createdAt: Date.now(),
      publicKey: Array.from(publicKey),
    };
    const answerSecret = `${'A'.repeat(43)}=`;
    expect(isValidSignalingPayload({ ...base, answerRelays: relays })).toBe(
      false,
    );
    expect(isValidSignalingPayload({ ...base, answerSecret })).toBe(false);
    expect(
      isValidSignalingPayload({ ...base, answerRelays: relays, answerSecret }),
    ).toBe(true);
    // Offer-only: an answer may never carry the channel.
    expect(
      isValidSignalingPayload({
        ...base,
        type: 'answer',
        answerRelays: relays,
        answerSecret,
      }),
    ).toBe(false);
    // A relay list that cannot be used is a malformed offer, not a silent
    // downgrade to the manual hop.
    expect(
      isValidSignalingPayload({
        ...base,
        answerRelays: ['wss://r1.example'],
        answerSecret,
      }),
    ).toBe(false);
    expect(
      isValidSignalingPayload({
        ...base,
        answerRelays: relays,
        answerSecret: 'too short',
      }),
    ).toBe(false);
  });

  it('keeps a channel-bearing offer within a few hundred extra bytes', () => {
    const plain = generateMutualOfferBinary(mockOffer, [], metadata);
    const withChannel = generateMutualOfferBinary(mockOffer, [], {
      ...metadata,
      answerRelays: relays,
      answerSecret: secret,
    });
    expect(withChannel.length - plain.length).toBeLessThan(200);
  });
});
