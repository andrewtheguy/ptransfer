import type { Event } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_MAX_BYTES,
  ANSWER_RELAY_COUNT,
  type AnswerChannel,
  decodeAnswerSecret,
  deriveAnswerChannel,
  encodeAnswerSecret,
  generateAnswerSecret,
  MIN_ANSWER_RELAYS,
  normalizeAnswerRelays,
  probeAnswerRelays,
  publishAnswer,
  sweepAnswerRelays,
  watchForAnswer,
} from './answer-channel';
import {
  answerChannelFromOffer,
  generateMutualAnswerBinary,
  generateMutualOfferBinary,
  parseMutualPayload,
} from './manual-signaling';
import { DEFAULT_RELAYS } from './nostr/relays';
import { createMockPool } from './nostr-file/mock-pool';
import type {
  CachedRelay,
  RelayPoolState,
  RelayPoolStorage,
} from './nostr-file/relay-pool';

const RELAYS = ['wss://r1.example', 'wss://r2.example', 'wss://r3.example'];
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 3600;

function secretBytes(fill = 9): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function answerBlob(fill = 42, length = 800): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** Resolve with the first answer the watch opens, or reject on timeout. */
function awaitAnswer(
  pool: ReturnType<typeof createMockPool>,
  relays: string[],
  channel: AnswerChannel,
  timeoutMs = 1000,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const watch = watchForAnswer(pool, relays, {
      channel,
      since: 0,
      onAnswer: (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
    });
    const timer = setTimeout(() => {
      watch.close();
      reject(new Error('no answer'));
    }, timeoutMs);
  });
}

/** Candidate/health cache backed by memory instead of IndexedDB. */
function memoryStorage(): RelayPoolStorage & {
  state: RelayPoolState | null;
  relayHealth: CachedRelay[];
} {
  const holder = {
    state: null as RelayPoolState | null,
    relayHealth: [] as CachedRelay[],
    getState: async () => holder.state,
    setState: async (state: RelayPoolState) => {
      holder.state = state;
    },
    getRelayHealth: async () => holder.relayHealth,
    setRelayHealth: async (relays: CachedRelay[]) => {
      holder.relayHealth = relays;
    },
  };
  return holder;
}

/** A NIP-66 relay-discovery event naming `url`, as a seed would serve it. */
function discoveryEvent(url: string): Event {
  return {
    kind: 30166,
    tags: [['d', url]],
    content: '',
    created_at: 0,
    pubkey: 'p',
    id: `i-${url}`,
    sig: 's',
  };
}

describe('answer channel derivation', () => {
  it('derives the same tag and a working key on both ends', async () => {
    const a = await deriveAnswerChannel(secretBytes());
    const b = await deriveAnswerChannel(secretBytes());
    expect(a.tag).toBe(b.tag);
    expect(a.tag).toMatch(/^[0-9a-f]{32}$/);
    expect(a.key.extractable).toBe(false);
  });

  it('gives a different channel for every secret', async () => {
    const a = await deriveAnswerChannel(secretBytes(1));
    const b = await deriveAnswerChannel(secretBytes(2));
    expect(a.tag).not.toBe(b.tag);
  });

  it('round-trips the secret through the offer encoding', () => {
    const secret = generateAnswerSecret();
    expect(secret).toHaveLength(32);
    const encoded = encodeAnswerSecret(secret);
    expect(decodeAnswerSecret(encoded)).toEqual(secret);
  });

  it('rejects secrets that are not 32 bytes of base64', () => {
    expect(decodeAnswerSecret('')).toBeNull();
    expect(decodeAnswerSecret('not base64!')).toBeNull();
    expect(
      decodeAnswerSecret(encodeAnswerSecret(new Uint8Array(16))),
    ).toBeNull();
  });
});

describe('normalizeAnswerRelays', () => {
  it('normalizes a usable list', () => {
    expect(
      normalizeAnswerRelays(['wss://r1.example/', 'wss://r2.example']),
    ).toEqual(['wss://r1.example', 'wss://r2.example']);
  });

  it('rejects a list below the floor, with duplicates, or with junk', () => {
    expect(normalizeAnswerRelays(['wss://r1.example'])).toBeNull();
    expect(
      normalizeAnswerRelays(['wss://r1.example', 'wss://r1.example/']),
    ).toBeNull();
    expect(normalizeAnswerRelays(['wss://r1.example', 'nope'])).toBeNull();
    expect(normalizeAnswerRelays(RELAYS.concat(RELAYS, RELAYS))).toBeNull();
    expect(normalizeAnswerRelays('wss://r1.example')).toBeNull();
  });
});

describe('publishing and watching for an answer', () => {
  it('carries the answer blob back byte for byte', async () => {
    const pool = createMockPool();
    const channel = await deriveAnswerChannel(secretBytes());
    const answer = answerBlob();
    const received = awaitAnswer(pool, RELAYS, channel);
    await publishAnswer(pool, RELAYS, {
      channel,
      answer,
      expiresAt: EXPIRES_AT,
    });
    expect(await received).toEqual(answer);
  });

  it('seals the answer: relays hold no plaintext and no other secret opens it', async () => {
    const pool = createMockPool();
    const channel = await deriveAnswerChannel(secretBytes(1));
    const answer = answerBlob();
    await publishAnswer(pool, RELAYS, {
      channel,
      answer,
      expiresAt: EXPIRES_AT,
    });

    const stored = pool.store.get(RELAYS[0]) ?? [];
    expect(stored).toHaveLength(1);
    const onWire = Uint8Array.from(atob(stored[0].content), (c) =>
      c.charCodeAt(0),
    );
    // nonce + ciphertext + tag, and nothing of the answer in the clear.
    expect(onWire.length).toBe(answer.length + 12 + 16);
    expect(onWire.subarray(12, 12 + answer.length)).not.toEqual(answer);
    expect(stored[0].tags).toContainEqual(['expiration', String(EXPIRES_AT)]);
    expect(stored[0].tags).toContainEqual(['x', channel.tag]);

    const other = await deriveAnswerChannel(secretBytes(2));
    await expect(awaitAnswer(pool, RELAYS, other, 200)).rejects.toThrow(
      'no answer',
    );
  });

  it('succeeds when a single relay accepts and the rest refuse', async () => {
    const pool = createMockPool({
      failRelays: new Set([RELAYS[0], RELAYS[1]]),
    });
    const channel = await deriveAnswerChannel(secretBytes());
    const answer = answerBlob();
    const received = awaitAnswer(pool, RELAYS, channel, 5000);
    await publishAnswer(pool, RELAYS, {
      channel,
      answer,
      expiresAt: EXPIRES_AT,
    });
    expect(await received).toEqual(answer);
  });

  it('throws when every relay refuses', async () => {
    const pool = createMockPool({ failRelays: new Set(RELAYS) });
    const channel = await deriveAnswerChannel(secretBytes());
    await expect(
      publishAnswer(pool, RELAYS, {
        channel,
        answer: answerBlob(),
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow('No relay accepted the response');
  });

  it('refuses an answer larger than the channel allows', async () => {
    const pool = createMockPool();
    const channel = await deriveAnswerChannel(secretBytes());
    await expect(
      publishAnswer(pool, RELAYS, {
        channel,
        answer: answerBlob(1, ANSWER_MAX_BYTES + 1),
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow('too large');
  });

  it('fires onAnswer once and then stops listening', async () => {
    const pool = createMockPool();
    const channel = await deriveAnswerChannel(secretBytes());
    const seen: Uint8Array[] = [];
    watchForAnswer(pool, RELAYS, {
      channel,
      since: 0,
      onAnswer: (answer) => seen.push(answer),
    });
    await publishAnswer(pool, RELAYS, {
      channel,
      answer: answerBlob(1),
      expiresAt: EXPIRES_AT,
    });
    await publishAnswer(pool, RELAYS, {
      channel,
      answer: answerBlob(2),
      expiresAt: EXPIRES_AT,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(1);
  });
});

describe('probeAnswerRelays', () => {
  it('returns the defaults that answered the write->read probe', async () => {
    const pool = createMockPool();
    const storage = memoryStorage();
    const relays = await probeAnswerRelays(pool, { storage });
    expect(relays.length).toBeGreaterThanOrEqual(MIN_ANSWER_RELAYS);
    expect(relays.length).toBeLessThanOrEqual(ANSWER_RELAY_COUNT);
    for (const relay of relays) {
      expect(DEFAULT_RELAYS as readonly string[]).toContain(relay);
    }
    // Every default passed, so discovery never ran and the cache is untouched.
    expect(storage.state).toBeNull();
    expect(storage.relayHealth).toEqual([]);
  });

  it('returns nothing when no default relay answers, without throwing', async () => {
    const pool = createMockPool({ failRelays: new Set(DEFAULT_RELAYS) });
    expect(await probeAnswerRelays(pool, { storage: memoryStorage() })).toEqual(
      [],
    );
  });

  it('backfills from discovered relays when the defaults come up short', async () => {
    const dead = DEFAULT_RELAYS.slice(2);
    const pool = createMockPool({ failRelays: new Set(dead) });
    // The surviving seeds serve NIP-66 listings for four more relays.
    const discovered = [
      'wss://found1.example',
      'wss://found2.example',
      'wss://found3.example',
      'wss://found4.example',
    ];
    for (const seed of DEFAULT_RELAYS.slice(0, 2)) {
      pool.store.set(seed, discovered.map(discoveryEvent));
    }
    const storage = memoryStorage();

    const relays = await probeAnswerRelays(pool, { storage });

    expect(relays).toHaveLength(ANSWER_RELAY_COUNT);
    // Working defaults lead; discovery fills the rest.
    expect(relays.slice(0, 2).sort()).toEqual(
      [...DEFAULT_RELAYS.slice(0, 2)].sort(),
    );
    expect(relays.slice(2).sort()).toEqual([...discovered].sort());
    for (const relay of relays) expect(dead).not.toContain(relay);
  });

  it('records control-probe verdicts in the shared relay cache', async () => {
    const pool = createMockPool({
      failRelays: new Set([...DEFAULT_RELAYS.slice(2), 'wss://bad.example']),
    });
    for (const seed of DEFAULT_RELAYS.slice(0, 2)) {
      pool.store.set(seed, [
        discoveryEvent('wss://good.example'),
        discoveryEvent('wss://bad.example'),
      ]);
    }
    const storage = memoryStorage();

    await probeAnswerRelays(pool, { storage });

    const good = storage.relayHealth.find(
      (relay) => relay.url === 'wss://good.example',
    );
    const bad = storage.relayHealth.find(
      (relay) => relay.url === 'wss://bad.example',
    );
    expect(good?.supportsControl).toBe(true);
    // A 256-byte round trip proves nothing about a full-size chunk.
    expect(good?.supportsStorage).toBe(false);
    expect(bad?.supportsControl).toBe(false);
    expect(bad?.consecutiveFailures).toBe(1);
    // The defaults are seeds, not cache entries.
    for (const relay of storage.relayHealth) {
      expect(DEFAULT_RELAYS as readonly string[]).not.toContain(relay.url);
    }
  });

  it('returns nothing when the defaults and discovery together fall short', async () => {
    const usable = new Set(DEFAULT_RELAYS.slice(0, 1));
    const pool = createMockPool({
      failRelays: new Set(DEFAULT_RELAYS.filter((r) => !usable.has(r))),
    });
    expect(await probeAnswerRelays(pool, { storage: memoryStorage() })).toEqual(
      [],
    );
  });
});

describe('sweepAnswerRelays', () => {
  it('enumerates and probes the relay population behind an exchange, leaving the answer relays alone', async () => {
    const found = ['wss://found1.example', 'wss://found2.example'];
    const pool = createMockPool({ failRelays: new Set([found[1]]) });
    for (const seed of DEFAULT_RELAYS) {
      pool.store.set(seed, found.map(discoveryEvent));
    }
    const storage = memoryStorage();
    const answerRelays = DEFAULT_RELAYS.slice(0, ANSWER_RELAY_COUNT);

    await sweepAnswerRelays(pool, answerRelays, { storage });

    const byUrl = new Map(storage.relayHealth.map((r) => [r.url, r]));
    expect([...byUrl.keys()].sort()).toEqual([...found].sort());
    expect(byUrl.get(found[0])?.supportsStorage).toBe(true);
    expect(byUrl.get(found[1])?.consecutiveFailures).toBe(1);
    for (const url of found) expect(pool.closedRelays).toContain(url);
    for (const url of answerRelays) {
      expect(pool.closedRelays).not.toContain(url);
    }
  });

  it('stops as soon as the signal fires and never throws', async () => {
    const pool = createMockPool();
    for (const seed of DEFAULT_RELAYS) {
      pool.store.set(seed, [discoveryEvent('wss://late.example')]);
    }
    const storage = memoryStorage();
    const controller = new AbortController();
    controller.abort();
    await expect(
      sweepAnswerRelays(pool, DEFAULT_RELAYS.slice(0, 2), {
        storage,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    expect(storage.relayHealth).toEqual([]);
  });
});

describe('offer to answer, end to end', () => {
  it("returns the receiver's answer to the sender without a second hop", async () => {
    const pool = createMockPool();
    // Sender: prove relays, then mint an offer that names them.
    const relays = await probeAnswerRelays(pool, { storage: memoryStorage() });
    const secret = generateAnswerSecret();
    const publicKey = new Uint8Array(65).fill(1);
    publicKey[0] = 4;
    const offerBinary = generateMutualOfferBinary(
      { type: 'offer', sdp: 'v=0\r\ns=offer' },
      [],
      {
        createdAt: Date.now(),
        fileName: 'test.txt',
        fileSize: 10,
        contentEncoding: 'identity',
        mimeType: 'text/plain',
        publicKey,
        salt: new Uint8Array(16).fill(2),
        answerRelays: relays,
        answerSecret: secret,
      },
    );
    const senderChannel = await deriveAnswerChannel(secret);
    const received = awaitAnswer(pool, relays, senderChannel);

    // Receiver: read the channel out of the hand-carried offer and answer on it.
    const offer = parseMutualPayload(offerBinary);
    expect(offer).not.toBeNull();
    const channel = answerChannelFromOffer(offer as never);
    expect(channel).not.toBeNull();
    const receiverPublicKey = new Uint8Array(65).fill(5);
    receiverPublicKey[0] = 4;
    const answerBinary = generateMutualAnswerBinary(
      { type: 'answer', sdp: 'v=0\r\ns=answer' },
      [],
      receiverPublicKey,
    );
    await publishAnswer(pool, channel?.relays ?? [], {
      channel: await deriveAnswerChannel(channel?.secret ?? new Uint8Array(32)),
      answer: answerBinary,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    // Sender: what came off the relays parses as the answer it was waiting for.
    const answer = parseMutualPayload(await received);
    expect(answer?.type).toBe('answer');
    expect(answer?.sdp).toBe('v=0\r\ns=answer');
    expect(answer?.publicKey).toEqual(Array.from(receiverPublicKey));
  });
});
