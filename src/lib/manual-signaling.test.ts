import { describe, expect, it } from 'vitest';
import {
  estimatePayloadSize,
  generateMutualAnswerBinary,
  generateMutualClipboardData,
  generateMutualOfferBinary,
  isMutualPayload,
  isValidSignalingPayload,
  normalizeOfferRelays,
  parseClipboardPayload,
  parseMutualPayload,
  relaysFromOffer,
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

describe('offer-borne fallback relays', () => {
  const mockOffer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0' };
  const publicKey = new Uint8Array(65).fill(1);
  publicKey[0] = 4;
  const salt = new Uint8Array(16).fill(2);
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

  it('round-trips the relays an offer advertises', () => {
    const binary = generateMutualOfferBinary(mockOffer, [], {
      ...metadata,
      relays,
    });
    const parsed = parseMutualPayload(binary);
    expect(parsed).not.toBeNull();
    expect(relaysFromOffer(parsed as SignalingPayload)).toEqual(relays);
  });

  it('advertises no relays when none were proven', () => {
    const binary = generateMutualOfferBinary(mockOffer, [], metadata);
    const parsed = parseMutualPayload(binary) as SignalingPayload;
    expect(parsed.relays).toBeUndefined();
    expect(relaysFromOffer(parsed)).toBeNull();
  });

  it('never carries an answer channel: an answer has no relay field', () => {
    const answer = parseMutualPayload(
      generateMutualAnswerBinary({ type: 'answer', sdp: 'v=0' }, [], publicKey),
    ) as SignalingPayload;
    expect(answer.relays).toBeUndefined();
    expect(relaysFromOffer(answer)).toBeNull();
    expect(Object.keys(answer).sort()).toEqual([
      'candidates',
      'createdAt',
      'publicKey',
      'sdp',
      'type',
    ]);
  });

  it('rejects a misplaced or unusable relay list', () => {
    const base = {
      type: 'offer',
      sdp: 'sdp',
      candidates: [],
      createdAt: Date.now(),
      publicKey: Array.from(publicKey),
    };
    expect(isValidSignalingPayload({ ...base, relays })).toBe(true);
    // Offer-only: an answer may never name relays.
    expect(isValidSignalingPayload({ ...base, type: 'answer', relays })).toBe(
      false,
    );
    // A relay list that cannot be used is a malformed offer, not a silent
    // downgrade to a relay-less one.
    expect(
      isValidSignalingPayload({ ...base, relays: ['wss://r1.example'] }),
    ).toBe(false);
    expect(isValidSignalingPayload({ ...base, relays: 'wss://r1' })).toBe(
      false,
    );
    // Legacy answer-channel fields are not part of the format any more.
    expect(
      isValidSignalingPayload({
        ...base,
        answerRelays: relays,
        answerSecret: `${'A'.repeat(43)}=`,
      }),
    ).toBe(true);
    expect(
      relaysFromOffer({
        ...base,
        answerRelays: relays,
      } as unknown as SignalingPayload),
    ).toBeNull();
  });

  it('keeps a relay-bearing offer within a couple hundred extra bytes', () => {
    const plain = generateMutualOfferBinary(mockOffer, [], metadata);
    const withRelays = generateMutualOfferBinary(mockOffer, [], {
      ...metadata,
      relays,
    });
    expect(withRelays.length - plain.length).toBeLessThan(200);
  });
});

describe('normalizeOfferRelays', () => {
  it('normalizes a usable list', () => {
    expect(
      normalizeOfferRelays(['wss://R1.example/', 'wss://r2.example']),
    ).toEqual(['wss://r1.example', 'wss://r2.example']);
  });

  it('rejects a list below the floor, with duplicates, or with junk', () => {
    expect(normalizeOfferRelays(['wss://r1.example'])).toBeNull();
    expect(
      normalizeOfferRelays(['wss://r1.example', 'wss://r1.example/']),
    ).toBeNull();
    expect(normalizeOfferRelays(['wss://r1.example', 42])).toBeNull();
    expect(normalizeOfferRelays(['wss://r1.example', 'nope'])).toBeNull();
    expect(normalizeOfferRelays('wss://r1.example')).toBeNull();
    expect(
      normalizeOfferRelays(
        Array.from({ length: 7 }, (_, i) => `wss://r${i}.example`),
      ),
    ).toBeNull();
  });
});
