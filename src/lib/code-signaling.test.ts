import { describe, expect, it } from 'vitest';
import {
  computeOfferTranscriptHash,
  decodeAnswerConfirmation,
  encodeAnswerConfirmation,
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
} from './code-signaling';
import {
  ANSWER_CONFIRMATION_BYTES,
  deriveAnswerConfirmation,
  deriveSharedSecretKey,
  generateECDHKeyPair,
} from './crypto';

describe('Code Exchange Signaling Utils', () => {
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
  const mockConfirmation = new Uint8Array(ANSWER_CONFIRMATION_BYTES).fill(3);

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
      mockConfirmation,
      createdAt,
    );

    expect(isMutualPayload(binary)).toBe(true);

    const parsed = await parseMutualPayload(binary);
    expect(parsed).toBeDefined();
    expect(parsed?.type).toBe('answer');
    expect(parsed?.sdp).toBe(mockOffer.sdp);
    expect(parsed?.publicKey).toEqual(Array.from(mockPublicKey));
    expect(decodeAnswerConfirmation(parsed?.confirm)).toEqual(mockConfirmation);
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
      generateMutualAnswerBinary(
        { type: 'answer', sdp: 'v=0' },
        [],
        publicKey,
        new Uint8Array(ANSWER_CONFIRMATION_BYTES).fill(3),
      ),
    ) as SignalingPayload;
    expect(answer.relays).toBeUndefined();
    expect(relaysFromOffer(answer)).toBeNull();
    expect(Object.keys(answer).sort()).toEqual([
      'candidates',
      'confirm',
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
    expect(
      isValidSignalingPayload({
        ...base,
        type: 'answer',
        confirm: encodeAnswerConfirmation(
          new Uint8Array(ANSWER_CONFIRMATION_BYTES),
        ),
        relays,
      }),
    ).toBe(false);
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

describe('answer confirmation tag', () => {
  const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0' };
  const salt = new Uint8Array(16).fill(2);
  const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0\r\na' };

  /** The offer bytes a sender would show, for a fresh sender keypair. */
  async function makeOffer(fileName = 'test.txt') {
    const senderKeys = await generateECDHKeyPair();
    const binary = generateMutualOfferBinary(offer, [], {
      createdAt: Date.now(),
      fileName,
      fileSize: 1024,
      contentEncoding: 'identity' as const,
      mimeType: 'text/plain',
      publicKey: senderKeys.publicKeyBytes,
      salt,
    });
    return { senderKeys, binary };
  }

  it('lets the sender confirm an answer built from its own offer', async () => {
    const { senderKeys, binary } = await makeOffer();

    // Receiver: derives against the offer's key and tags its answer.
    const parsed = parseMutualPayload(binary) as SignalingPayload;
    const receiverKeys = await generateECDHKeyPair();
    const receiverSecret = await deriveSharedSecretKey(
      receiverKeys.privateKey,
      new Uint8Array(parsed.publicKey),
    );
    const answerBinary = generateMutualAnswerBinary(
      answer,
      [],
      receiverKeys.publicKeyBytes,
      await deriveAnswerConfirmation(
        receiverSecret,
        salt,
        await computeOfferTranscriptHash(binary),
      ),
    );

    // Sender: recomputes from its own offer bytes and the answer's key.
    const answerPayload = parseMutualPayload(answerBinary) as SignalingPayload;
    const senderSecret = await deriveSharedSecretKey(
      senderKeys.privateKey,
      new Uint8Array(answerPayload.publicKey),
    );
    const expected = await deriveAnswerConfirmation(
      senderSecret,
      salt,
      await computeOfferTranscriptHash(binary),
    );

    expect(decodeAnswerConfirmation(answerPayload.confirm)).toEqual(expected);
  });

  it('does not verify against a different offer', async () => {
    const a = await makeOffer('a.txt');
    const b = await makeOffer('b.txt');
    const receiverKeys = await generateECDHKeyPair();
    const secret = await deriveSharedSecretKey(
      receiverKeys.privateKey,
      new Uint8Array(
        (parseMutualPayload(a.binary) as SignalingPayload).publicKey,
      ),
    );

    const forA = await deriveAnswerConfirmation(
      secret,
      salt,
      await computeOfferTranscriptHash(a.binary),
    );
    const forB = await deriveAnswerConfirmation(
      secret,
      salt,
      await computeOfferTranscriptHash(b.binary),
    );

    expect(forA).not.toEqual(forB);
  });

  it('does not verify for a peer that answered with a different key', async () => {
    const { senderKeys, binary } = await makeOffer();
    const transcript = await computeOfferTranscriptHash(binary);
    const [one, two] = await Promise.all([
      generateECDHKeyPair(),
      generateECDHKeyPair(),
    ]);

    const [first, second] = await Promise.all(
      [one, two].map(async (keys) =>
        deriveAnswerConfirmation(
          await deriveSharedSecretKey(
            senderKeys.privateKey,
            keys.publicKeyBytes,
          ),
          salt,
          transcript,
        ),
      ),
    );

    expect(first).not.toEqual(second);
  });

  it('hashes the container bytes, so any edit changes the transcript', async () => {
    const { binary } = await makeOffer();
    const tampered = new Uint8Array(binary);
    tampered[tampered.length - 1] ^= 0xff;

    expect(await computeOfferTranscriptHash(binary)).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeOfferTranscriptHash(tampered)).not.toBe(
      await computeOfferTranscriptHash(binary),
    );
  });

  it('requires a well-formed tag on every answer', async () => {
    const base = {
      type: 'answer',
      sdp: 'sdp',
      candidates: [],
      createdAt: Date.now(),
      publicKey: Array.from((await generateECDHKeyPair()).publicKeyBytes),
    };
    const valid = encodeAnswerConfirmation(
      new Uint8Array(ANSWER_CONFIRMATION_BYTES).fill(9),
    );

    expect(isValidSignalingPayload({ ...base, confirm: valid })).toBe(true);
    // Missing, wrong width, or not base64 at all.
    expect(isValidSignalingPayload(base)).toBe(false);
    expect(isValidSignalingPayload({ ...base, confirm: '' })).toBe(false);
    expect(
      isValidSignalingPayload({
        ...base,
        confirm: encodeAnswerConfirmation(new Uint8Array(8)),
      }),
    ).toBe(false);
    expect(
      isValidSignalingPayload({ ...base, confirm: '!'.repeat(valid.length) }),
    ).toBe(false);
    expect(isValidSignalingPayload({ ...base, confirm: 42 })).toBe(false);
    // Offers have nothing earlier to bind to, so they may not carry one.
    expect(
      isValidSignalingPayload({ ...base, type: 'offer', confirm: valid }),
    ).toBe(false);
  });

  it('round-trips a tag through base64', () => {
    const tag = new Uint8Array(ANSWER_CONFIRMATION_BYTES).map((_, i) => i * 7);
    expect(decodeAnswerConfirmation(encodeAnswerConfirmation(tag))).toEqual(
      tag,
    );
    expect(decodeAnswerConfirmation(undefined)).toBeNull();
  });

  it('costs an answer only a few dozen bytes', async () => {
    const withTag = generateMutualAnswerBinary(
      answer,
      [],
      (await generateECDHKeyPair()).publicKeyBytes,
      new Uint8Array(ANSWER_CONFIRMATION_BYTES).fill(3),
    );
    const parsed = parseMutualPayload(withTag) as SignalingPayload;
    const { confirm: _confirm, ...withoutTag } = parsed;
    expect(
      withTag.length - estimatePayloadSize(withoutTag as SignalingPayload),
    ).toBeLessThan(64);
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
