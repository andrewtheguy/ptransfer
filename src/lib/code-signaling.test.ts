import { describe, expect, it } from 'vitest';
import {
  computeAnswerTranscriptHash,
  computeOfferTranscriptHash,
  decodeAnswerConfirmation,
  encodeAnswerConfirmation,
  estimatePayloadSize,
  generateMutualAnswerBinary,
  generateMutualClipboardData,
  generateMutualOfferBinary,
  isAnonymousOffer,
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
  const stubSigner = async () =>
    new Uint8Array(ANSWER_CONFIRMATION_BYTES).fill(3);

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
      stubSigner,
      createdAt,
    );

    expect(isMutualPayload(binary)).toBe(true);

    const parsed = await parseMutualPayload(binary);
    expect(parsed).toBeDefined();
    expect(parsed?.type).toBe('answer');
    expect(parsed?.sdp).toBe(mockOffer.sdp);
    expect(parsed?.publicKey).toEqual(Array.from(mockPublicKey));
    expect(decodeAnswerConfirmation(parsed?.confirm)).toEqual(
      await stubSigner(),
    );
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

  it('never carries an answer channel: an answer has no relay field', async () => {
    const answer = parseMutualPayload(
      await generateMutualAnswerBinary(
        { type: 'answer', sdp: 'v=0' },
        [],
        publicKey,
        async () => new Uint8Array(ANSWER_CONFIRMATION_BYTES).fill(3),
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

describe('the anonymous fallback flag', () => {
  const mockOffer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0' };
  const publicKey = new Uint8Array(65).fill(1);
  publicKey[0] = 4;
  const relays = ['wss://r1.example', 'wss://r2.example'];
  const metadata = {
    createdAt: Date.now(),
    fileName: 'test.txt',
    fileSize: 1024,
    contentEncoding: 'deflate-raw' as const,
    mimeType: 'text/plain',
    publicKey,
    salt: new Uint8Array(16).fill(2),
  };

  it('round-trips, and names no relays alongside it', () => {
    const parsed = parseMutualPayload(
      generateMutualOfferBinary(mockOffer, [], {
        ...metadata,
        anonymous: true,
      }),
    ) as SignalingPayload;
    expect(isAnonymousOffer(parsed)).toBe(true);
    // The onion relay pool is a constant on both sides, so there is nothing
    // for the offer to name — and a clearnet list would contradict the mode.
    expect(parsed.relays).toBeUndefined();
    expect(relaysFromOffer(parsed)).toBeNull();
  });

  it('is absent from an ordinary offer, relays or not', () => {
    for (const extra of [{}, { relays }]) {
      const parsed = parseMutualPayload(
        generateMutualOfferBinary(mockOffer, [], { ...metadata, ...extra }),
      ) as SignalingPayload;
      expect(parsed.anon).toBeUndefined();
      expect(isAnonymousOffer(parsed)).toBe(false);
    }
  });

  it('wins over a relay list the caller passed anyway', () => {
    const parsed = parseMutualPayload(
      generateMutualOfferBinary(mockOffer, [], {
        ...metadata,
        relays,
        anonymous: true,
      }),
    ) as SignalingPayload;
    expect(isAnonymousOffer(parsed)).toBe(true);
    expect(parsed.relays).toBeUndefined();
  });

  it('rejects a misplaced, false, or relay-bearing flag', () => {
    const base = {
      type: 'offer',
      sdp: 'sdp',
      candidates: [],
      createdAt: Date.now(),
      publicKey: Array.from(publicKey),
    };
    expect(isValidSignalingPayload({ ...base, anon: true })).toBe(true);
    // One-valued: an offer that says which fallback it is not is malformed.
    expect(isValidSignalingPayload({ ...base, anon: false })).toBe(false);
    expect(isValidSignalingPayload({ ...base, anon: 1 })).toBe(false);
    // Offer-only.
    expect(
      isValidSignalingPayload({
        ...base,
        type: 'answer',
        confirm: encodeAnswerConfirmation(
          new Uint8Array(ANSWER_CONFIRMATION_BYTES),
        ),
        anon: true,
      }),
    ).toBe(false);
    // The two fallbacks are alternatives; an offer carrying both would be
    // asking the receiver to pick one.
    expect(isValidSignalingPayload({ ...base, anon: true, relays })).toBe(
      false,
    );
  });

  it('is not something an answer can be', async () => {
    const answer = parseMutualPayload(
      await generateMutualAnswerBinary(
        { type: 'answer', sdp: 'v=0' },
        [],
        publicKey,
        async () => new Uint8Array(ANSWER_CONFIRMATION_BYTES).fill(3),
      ),
    ) as SignalingPayload;
    expect(isAnonymousOffer(answer)).toBe(false);
  });
});

describe('answer confirmation tag', () => {
  const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0' };
  const salt = new Uint8Array(16).fill(2);
  const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'v=0\r\na' };
  const iceCandidates = [
    { candidate: 'candidate:1 1 UDP 123 10.0.0.1 5000 typ host' },
  ] as RTCIceCandidate[];

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

  /** What the receiver does: agree on a key, then sign the answer it sends. */
  async function makeAnswer(
    offerBinary: Uint8Array,
    candidates: RTCIceCandidate[] = [],
  ) {
    const parsed = parseMutualPayload(offerBinary) as SignalingPayload;
    const receiverKeys = await generateECDHKeyPair();
    const secret = await deriveSharedSecretKey(
      receiverKeys.privateKey,
      new Uint8Array(parsed.publicKey),
    );
    const offerTranscriptHash = await computeOfferTranscriptHash(offerBinary);
    const binary = await generateMutualAnswerBinary(
      answer,
      candidates,
      receiverKeys.publicKeyBytes,
      (answerTranscriptHash) =>
        deriveAnswerConfirmation(secret, salt, {
          offerTranscriptHash,
          answerTranscriptHash,
        }),
    );
    return { binary, receiverKeys };
  }

  /** What the sender does: recompute the tag it expects for what it holds. */
  async function expectedTag(
    senderPrivateKey: CryptoKey,
    offerBinary: Uint8Array,
    answerPayload: SignalingPayload,
  ) {
    return deriveAnswerConfirmation(
      await deriveSharedSecretKey(
        senderPrivateKey,
        new Uint8Array(answerPayload.publicKey),
      ),
      salt,
      {
        offerTranscriptHash: await computeOfferTranscriptHash(offerBinary),
        answerTranscriptHash: await computeAnswerTranscriptHash(answerPayload),
      },
    );
  }

  it('lets the sender confirm an answer built from its own offer', async () => {
    const { senderKeys, binary } = await makeOffer();
    const { binary: answerBinary } = await makeAnswer(binary, iceCandidates);

    const answerPayload = parseMutualPayload(answerBinary) as SignalingPayload;
    expect(decodeAnswerConfirmation(answerPayload.confirm)).toEqual(
      await expectedTag(senderKeys.privateKey, binary, answerPayload),
    );
  });

  it('rejects an answer whose SDP was edited in transit', async () => {
    const { senderKeys, binary } = await makeOffer();
    const { binary: answerBinary } = await makeAnswer(binary, iceCandidates);
    const answerPayload = parseMutualPayload(answerBinary) as SignalingPayload;

    // Public key and tag left intact — only the SDP is swapped.
    const tampered: SignalingPayload = {
      ...answerPayload,
      sdp: `${answerPayload.sdp}\r\na=recvonly`,
    };

    expect(decodeAnswerConfirmation(tampered.confirm)).not.toEqual(
      await expectedTag(senderKeys.privateKey, binary, tampered),
    );
  });

  it('rejects an answer whose ICE candidates were edited in transit', async () => {
    const { senderKeys, binary } = await makeOffer();
    const { binary: answerBinary } = await makeAnswer(binary, iceCandidates);
    const answerPayload = parseMutualPayload(answerBinary) as SignalingPayload;

    for (const candidates of [
      [],
      [
        ...answerPayload.candidates,
        'candidate:2 1 UDP 1 10.0.0.9 6000 typ host',
      ],
      ['candidate:1 1 UDP 123 10.0.0.2 5000 typ host'],
    ]) {
      const tampered: SignalingPayload = { ...answerPayload, candidates };
      expect(decodeAnswerConfirmation(tampered.confirm)).not.toEqual(
        await expectedTag(senderKeys.privateKey, binary, tampered),
      );
    }
  });

  it('rejects an answer whose timestamp was edited in transit', async () => {
    const { senderKeys, binary } = await makeOffer();
    const { binary: answerBinary } = await makeAnswer(binary);
    const answerPayload = parseMutualPayload(answerBinary) as SignalingPayload;

    const tampered: SignalingPayload = {
      ...answerPayload,
      createdAt: answerPayload.createdAt + 1,
    };

    expect(decodeAnswerConfirmation(tampered.confirm)).not.toEqual(
      await expectedTag(senderKeys.privateKey, binary, tampered),
    );
  });

  it('does not verify against a different offer', async () => {
    const a = await makeOffer('a.txt');
    const b = await makeOffer('b.txt');
    const { binary: answerBinary } = await makeAnswer(a.binary);
    const answerPayload = parseMutualPayload(answerBinary) as SignalingPayload;

    // The answer is genuine and unaltered; only the offer it is checked
    // against differs.
    expect(decodeAnswerConfirmation(answerPayload.confirm)).toEqual(
      await expectedTag(a.senderKeys.privateKey, a.binary, answerPayload),
    );
    expect(decodeAnswerConfirmation(answerPayload.confirm)).not.toEqual(
      await expectedTag(a.senderKeys.privateKey, b.binary, answerPayload),
    );
  });

  it('does not verify for a peer that answered with a different key', async () => {
    const { senderKeys, binary } = await makeOffer();
    const binding = {
      offerTranscriptHash: await computeOfferTranscriptHash(binary),
      answerTranscriptHash: 'f'.repeat(64),
    };
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
          binding,
        ),
      ),
    );

    expect(first).not.toEqual(second);
  });

  it('hashes the offer container bytes, so any edit changes the transcript', async () => {
    const { binary } = await makeOffer();
    const tampered = new Uint8Array(binary);
    tampered[tampered.length - 1] ^= 0xff;

    expect(await computeOfferTranscriptHash(binary)).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeOfferTranscriptHash(tampered)).not.toBe(
      await computeOfferTranscriptHash(binary),
    );
  });

  it('hashes every answer field the sender acts on, and not the tag', async () => {
    const { binary: answerBinary } = await makeAnswer(
      (await makeOffer()).binary,
    );
    const payload = parseMutualPayload(answerBinary) as SignalingPayload;
    const base = await computeAnswerTranscriptHash(payload);

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    // The tag lives inside the payload it covers, so it cannot cover itself.
    expect(
      await computeAnswerTranscriptHash({
        ...payload,
        confirm: encodeAnswerConfirmation(
          new Uint8Array(ANSWER_CONFIRMATION_BYTES).fill(1),
        ),
      }),
    ).toBe(base);
    // Everything else the sender reads is covered.
    for (const edit of [
      { sdp: 'v=0' },
      { candidates: ['candidate:9 1 UDP 1 10.0.0.9 9000 typ host'] },
      { createdAt: payload.createdAt + 1 },
      { publicKey: Array.from((await generateECDHKeyPair()).publicKeyBytes) },
      { type: 'offer' as const },
    ]) {
      expect(
        await computeAnswerTranscriptHash({ ...payload, ...edit }),
      ).not.toBe(base);
    }
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
    const { binary } = await makeAnswer((await makeOffer()).binary);
    const parsed = parseMutualPayload(binary) as SignalingPayload;
    const { confirm: _confirm, ...withoutTag } = parsed;
    expect(
      binary.length - estimatePayloadSize(withoutTag as SignalingPayload),
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
