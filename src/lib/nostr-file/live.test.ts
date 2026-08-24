import type { Event } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { generateEphemeralKeys, uint8ArrayToBase64 } from '../nostr/events';
import { DEFAULT_RELAYS } from '../nostr/relays';
import { chunkAad, encodeChunkContent, sha256 } from './codec';
import { LIVE_BATCH_CHUNKS, NOSTR_FILE_CHUNK_SIZE } from './constants';
import {
  type AckMessage,
  deriveControlKey,
  encodePosition,
  openControlChannel,
  parseReceiverMessage,
} from './control';
import { type LiveReceiveProgress, receiveFileLive } from './download-live';
import { buildChunkEvent } from './events';
import type { NostrFileManifest } from './manifest';
import { createMockPool, type MockPool } from './mock-pool';
import type {
  CachedRelay,
  RelayPoolState,
  RelayPoolStorage,
} from './relay-pool';
import { type LiveSendProgress, sendFileLive } from './upload-live';

// crypto.getRandomValues caps at 65536 bytes per call
function randomBytes(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(data.subarray(offset, offset + 65536));
  }
  return data;
}

const RELAYS = ['wss://r1.example', 'wss://r2.example', 'wss://r3.example'];
const CONTROL_RELAYS = ['wss://c1.example', 'wss://c2.example'];
// Most tests here exercise relay mechanics with random (incompressible)
// bytes; sending them as the precompressed multi-file flow keeps the
// byte-to-chunk math exact. Compression-rule tests override `precompressed`.
const META = {
  fileName: 'live.bin',
  mimeType: 'application/octet-stream',
  precompressed: true,
};
const never = () => false;
const noProgress = () => {};

function memoryStorage(
  initial: RelayPoolState | null = null,
): RelayPoolStorage {
  let state: RelayPoolState | null = initial;
  let relayHealth: CachedRelay[] = [];
  return {
    getState: async () => state,
    setState: async (s) => {
      state = s;
    },
    getRelayHealth: async () => relayHealth,
    setRelayHealth: async (relays) => {
      relayHealth = relays;
    },
  };
}

function isControlEvent(event: Event): boolean {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  return dTag.includes(':ctl:');
}

function chunkIndexOf(event: Event): number | null {
  // Health probes carry a chunk tag too but live under the probe x-tag.
  if (event.tags.some((t) => t[0] === 'x' && t[1] === 'probe')) return null;
  const chunkTag = event.tags.find((t) => t[0] === 'chunk');
  return chunkTag ? Number(chunkTag[1]) : null;
}

// Map of chunk index -> relays holding a copy (control and probe events
// excluded).
function chunkPlacements(pool: MockPool): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [relay, events] of pool.store) {
    for (const ev of events) {
      const index = chunkIndexOf(ev);
      if (index === null) continue;
      out.set(index, [...(out.get(index) ?? []), relay]);
    }
  }
  return out;
}

/**
 * Run sender and receiver against the same mock network, handing the
 * manifest + key over exactly as the manual payload would.
 */
async function liveRoundTrip(
  pool: MockPool,
  data: Uint8Array,
  opts: {
    relays?: string[];
    precompressed?: boolean;
    onSend?: (p: LiveSendProgress) => void;
    onReceive?: (p: LiveReceiveProgress) => void;
    senderCancelled?: () => boolean;
    receiverCancelled?: () => boolean;
  } = {},
) {
  type Handover = { manifest: NostrFileManifest; keyBytes: Uint8Array };
  let readyResolve!: (v: Handover) => void;
  const handover = new Promise<Handover>((resolve) => {
    readyResolve = resolve;
  });

  const sendDone = sendFileLive(
    data,
    { ...META, precompressed: opts.precompressed ?? META.precompressed },
    {
      pool,
      isCancelled: opts.senderCancelled ?? never,
      controlRelayOverride: CONTROL_RELAYS,
      dataRelayOverride: opts.relays ?? RELAYS,
      onProgress: opts.onSend ?? noProgress,
      onReady: (m, keyBytes) =>
        readyResolve({ manifest: m, keyBytes: new Uint8Array(keyBytes) }),
    },
  );
  // The caller awaits sendDone; this only keeps an early rejection from
  // being reported as unhandled meanwhile.
  sendDone.catch(() => {});
  // Surface sender failures that happen before handover.
  const ready = await Promise.race([
    handover,
    sendDone.then(() => {
      throw new Error('sender finished before handing over the code');
    }),
  ]);
  const receiveDone = receiveFileLive(ready.manifest, ready.keyBytes, {
    pool,
    isCancelled: opts.receiverCancelled ?? never,
    onProgress: opts.onReceive ?? noProgress,
  });
  receiveDone.catch(() => {});
  return { manifest: ready.manifest, sendDone, receiveDone };
}

describe('live single-copy relay transfer', () => {
  it('hands over the code before uploading and stores exactly one copy per chunk', async () => {
    const pool = createMockPool();
    const data = randomBytes(4 * NOSTR_FILE_CHUNK_SIZE - 5000); // 4 chunks
    const sendProgress: LiveSendProgress[] = [];
    let chunksUploadedAtHandover = -1;

    const { manifest, sendDone, receiveDone } = await liveRoundTrip(
      pool,
      data,
      {
        onSend: (p) => {
          sendProgress.push(p);
          if (chunksUploadedAtHandover < 0 && p.phase === 'transfer') {
            chunksUploadedAtHandover = p.chunksDone ?? 0;
          }
        },
      },
    );
    const [received] = await Promise.all([receiveDone, sendDone]);

    expect(received).toEqual(data);
    expect(chunksUploadedAtHandover).toBe(0);
    // The payload names the control relays only; the ring travels in avails.
    expect(manifest.controlRelays).toEqual(CONTROL_RELAYS);
    const placed = chunkPlacements(pool);
    expect(placed.size).toBe(4);
    for (let i = 0; i < 4; i++) {
      // One copy, on the default ring position.
      expect(placed.get(i)).toEqual([RELAYS[i % RELAYS.length]]);
    }
    // Control traffic and chunk traffic never share a relay.
    for (const relay of CONTROL_RELAYS) {
      const events = pool.store.get(relay) ?? [];
      expect(events.length).toBeGreaterThan(0);
      expect(events.every(isControlEvent)).toBe(true);
    }
    for (const relay of RELAYS) {
      const events = pool.store.get(relay) ?? [];
      expect(events.some(isControlEvent)).toBe(false);
    }
    const last = sendProgress.at(-1);
    expect(last?.phase).toBe('transfer');
    expect(last?.receiverConnected).toBe(true);
    expect(last?.receiverHave).toBe(4);
    expect(last?.resent).toBe(0);
    // Stats rows are split by job, and control publishes are tallied per
    // relay too (every control message fans out to all control relays).
    const rowsByRole = (role: string) =>
      (last?.stats.relays ?? []).filter((r) => r.role === role);
    expect(rowsByRole('control').map((r) => r.url)).toEqual(CONTROL_RELAYS);
    expect(rowsByRole('storage').map((r) => r.url)).toEqual(RELAYS);
    for (const row of rowsByRole('control')) {
      expect(row.eventsAccepted).toBeGreaterThan(0);
      expect(row.bytesUp).toBeGreaterThan(0);
    }
  });

  it('deflates a compressible single-file payload once, so it spans far fewer chunks', async () => {
    const pool = createMockPool();
    // 20 chunks raw; deflates to a fraction of one chunk.
    const data = new TextEncoder()
      .encode('the same line of text, over and over\n'.repeat(26_600))
      .slice(0, 20 * NOSTR_FILE_CHUNK_SIZE);
    const { manifest, sendDone, receiveDone } = await liveRoundTrip(
      pool,
      data,
      {
        precompressed: false,
      },
    );
    const [received] = await Promise.all([receiveDone, sendDone]);
    expect(received).toEqual(data);
    expect(manifest.compression).toBe('deflate');
    expect(manifest.fileSize).toBe(data.length);
    expect(manifest.payloadSize).toBeLessThan(data.length / 10);
    expect(manifest.totalChunks).toBe(1);
    expect(chunkPlacements(pool).size).toBe(1);
  }, 15000);

  it('deflates a single-file payload even when that does not shrink it', async () => {
    const pool = createMockPool();
    const data = randomBytes(100_000);
    const { manifest, sendDone, receiveDone } = await liveRoundTrip(
      pool,
      data,
      {
        precompressed: false,
      },
    );
    const [received] = await Promise.all([receiveDone, sendDone]);
    expect(received).toEqual(data);
    expect(manifest.compression).toBe('deflate');
    expect(manifest.fileSize).toBe(data.length);
    // Random bytes do not compress; raw deflate adds stored-block framing.
    expect(manifest.payloadSize).toBeGreaterThanOrEqual(data.length);
  }, 15000);

  it('never recompresses a payload from the multi-file/folder flow', async () => {
    const pool = createMockPool();
    const data = randomBytes(4 * NOSTR_FILE_CHUNK_SIZE - 5000);
    const { manifest, sendDone, receiveDone } = await liveRoundTrip(pool, data);
    const [received] = await Promise.all([receiveDone, sendDone]);
    expect(received).toEqual(data);
    expect(manifest.compression).toBe('none');
    expect(manifest.payloadSize).toBe(data.length);
    expect(manifest.totalChunks).toBe(4);
  }, 15000);

  it('re-sends only the pieces the receiver could not fetch, to the next relay', async () => {
    // r2 acknowledges uploads but never serves them: every chunk placed
    // there is reported missing by the receiver and must be re-sent.
    const pool = createMockPool({
      blackholeRelays: new Set(['wss://r2.example']),
    });
    const data = randomBytes(7 * NOSTR_FILE_CHUNK_SIZE - 5000); // 7 chunks: 1, 4 land on r2 first
    const sendProgress: LiveSendProgress[] = [];
    const { sendDone, receiveDone } = await liveRoundTrip(pool, data, {
      onSend: (p) => sendProgress.push(p),
    });
    const [received] = await Promise.all([receiveDone, sendDone]);
    expect(received).toEqual(data);

    const placed = chunkPlacements(pool);
    for (let i = 0; i < 7; i++) {
      const copies = placed.get(i) ?? [];
      // Never more than one stored copy: the failed copy was never stored,
      // and the re-send went to exactly one other relay.
      expect(copies).toHaveLength(1);
      if (i % 3 === 1) {
        // Re-sent to the next ring position after the blackholed relay.
        expect(copies).toEqual(['wss://r3.example']);
      } else {
        expect(copies).toEqual([RELAYS[i % 3]]);
      }
    }
    expect(sendProgress.at(-1)?.resent).toBe(2);
  }, 15000);

  it('demotes a relay that keeps rejecting publishes', async () => {
    // r2 rejects every publish. Chunks whose ring walk starts there give up
    // after the retry schedule and land elsewhere; after enough give-ups the
    // relay is demoted without the receiver ever reporting a miss.
    const bad = RELAYS[1];
    const pool = createMockPool({ failRelays: new Set([bad]) });
    const data = randomBytes(12 * NOSTR_FILE_CHUNK_SIZE); // chunks 1, 4, 7, 10 start on r2
    const sendProgress: LiveSendProgress[] = [];
    const { sendDone, receiveDone } = await liveRoundTrip(pool, data, {
      onSend: (p) => sendProgress.push(p),
    });
    const [received] = await Promise.all([receiveDone, sendDone]);
    expect(received).toEqual(data);

    for (const copies of chunkPlacements(pool).values()) {
      expect(copies).toHaveLength(1);
      expect(copies).not.toContain(bad);
    }
    const stats = sendProgress.at(-1)?.stats;
    const badRow = stats?.relays.find((r) => r.url === bad);
    expect(badRow?.demoted).toBe(true);
    expect(badRow?.eventsAccepted).toBe(0);
    // A give-up demotion is publish-side only — no re-sends were needed.
    expect(sendProgress.at(-1)?.resent).toBe(0);
  }, 20000);

  it('demotes a relay the receiver keeps missing chunks on', async () => {
    // r2 blackholes reads. Publishes of the second batch are held until the
    // receiver's first acknowledgement has demoted r2, so every chunk placed
    // after that point must avoid it and never need a re-send.
    const chunks = LIVE_BATCH_CHUNKS + 40;
    // Bounded: if the demotion never happens the gate opens anyway, so the
    // assertion below reports why rather than the test timing out.
    let demoted = false;
    let openGate!: () => void;
    let gateTimer: ReturnType<typeof setTimeout>;
    const demotedGate = new Promise<void>((resolve) => {
      openGate = () => {
        clearTimeout(gateTimer);
        resolve();
      };
      gateTimer = setTimeout(resolve, 10_000);
    });
    const release = () => {
      if (demoted) return;
      demoted = true;
      openGate();
    };
    const publishes: { relay: string; index: number }[] = [];
    const pool = createMockPool({
      blackholeRelays: new Set(['wss://r2.example']),
      beforePublish: async (relay, event) => {
        const index = chunkIndexOf(event);
        if (index === null) return;
        if (index >= LIVE_BATCH_CHUNKS) await demotedGate;
        publishes.push({ relay, index });
      },
    });
    const data = randomBytes(chunks * NOSTR_FILE_CHUNK_SIZE - 10);
    const sendProgress: LiveSendProgress[] = [];
    const { sendDone, receiveDone } = await liveRoundTrip(pool, data, {
      onSend: (p) => {
        sendProgress.push(p);
        if (p.relaysDemoted === 1) release();
      },
    });
    const [received] = await Promise.all([receiveDone, sendDone]);
    expect(received).toEqual(data);

    // Everything below assumes the second batch was published after r2 was
    // demoted; say so first if it was not.
    expect(demoted, 'r2 was never demoted — the gate opened on timeout').toBe(
      true,
    );
    const placed = chunkPlacements(pool);
    for (let i = 0; i < chunks; i++) {
      // Exactly one readable copy: only chunks that landed on the blackholed
      // relay are re-sent, and a healthy relay is never blamed for a chunk the
      // receiver did not ask it for.
      expect(placed.get(i) ?? []).toHaveLength(1);
    }
    const last = sendProgress.at(-1);
    expect(last?.relaysDemoted).toBe(1);
    // The first batch put a third of its chunks on r2 and each needed one
    // re-send; the in-flight workers parked at the gate had already picked
    // r2 for at most their own chunk each. Nothing beyond that went to r2.
    const firstBatchOnR2 = Math.ceil(LIVE_BATCH_CHUNKS / 3);
    const r2Publishes = publishes.filter((p) => p.relay === 'wss://r2.example');
    expect(r2Publishes.length).toBeGreaterThanOrEqual(firstBatchOnR2);
    expect(r2Publishes.length).toBeLessThanOrEqual(firstBatchOnR2 + 16);
    const lateOnR2 = r2Publishes.filter(
      (p) => p.index >= LIVE_BATCH_CHUNKS + 16,
    );
    expect(lateOnR2).toEqual([]);
    expect(last?.resent).toBe(r2Publishes.length);
    expect(last?.resent).toBeLessThan(Math.floor(chunks / 3));
  }, 30000);

  it('announces availability per batch and completes a multi-batch file', async () => {
    const pool = createMockPool();
    const chunks = LIVE_BATCH_CHUNKS + 6;
    const data = randomBytes(chunks * NOSTR_FILE_CHUNK_SIZE - 100);
    const availableSeen = new Set<number>();
    const { sendDone, receiveDone } = await liveRoundTrip(pool, data, {
      onReceive: (p) => availableSeen.add(p.available),
    });
    const [received] = await Promise.all([receiveDone, sendDone]);
    expect(received).toEqual(data);
    // The first batch was announced on its own before the tail.
    expect(availableSeen.has(LIVE_BATCH_CHUNKS)).toBe(true);
    expect(availableSeen.has(chunks)).toBe(true);
    expect(chunkPlacements(pool).size).toBe(chunks);
  }, 30000);

  it('falls back around the ring when a relay rejects uploads', async () => {
    const pool = createMockPool({ failRelays: new Set(['wss://r1.example']) });
    const data = randomBytes(4 * NOSTR_FILE_CHUNK_SIZE - 5000); // 4 chunks: 0 and 3 would go to r1
    const { sendDone, receiveDone } = await liveRoundTrip(pool, data);
    const [received] = await Promise.all([receiveDone, sendDone]);
    expect(received).toEqual(data);
    const placed = chunkPlacements(pool);
    expect(placed.get(0)).toEqual(['wss://r2.example']);
    expect(placed.get(3)).toEqual(['wss://r2.example']);
    expect(pool.store.get('wss://r1.example')).toBeUndefined();
  }, 20000);

  it('tells the sender when the receiver cancels', async () => {
    const pool = createMockPool();
    const data = randomBytes(1000);
    let receiverCancelled = false;
    const { sendDone, receiveDone } = await liveRoundTrip(pool, data, {
      receiverCancelled: () => receiverCancelled,
      onReceive: () => {
        receiverCancelled = true;
      },
    });
    await expect(receiveDone).rejects.toThrow(/cancelled/i);
    await expect(sendDone).rejects.toThrow(/receiver cancelled/i);
  }, 15000);

  it('tells the receiver when the sender cancels', async () => {
    const pool = createMockPool();
    const data = randomBytes(13 * NOSTR_FILE_CHUNK_SIZE - 5000); // 13 chunks
    let senderCancelled = false;
    const { sendDone, receiveDone } = await liveRoundTrip(pool, data, {
      senderCancelled: () => senderCancelled,
      // Cancel as soon as the code is out and the upload has begun.
      onSend: (p) => {
        if (p.phase === 'transfer') senderCancelled = true;
      },
    });
    await expect(sendDone).rejects.toThrow(/cancelled/i);
    // The sender's wind-down notice reaches the receiver, so it stops waiting
    // instead of sitting out its 3-minute idle watchdog.
    await expect(receiveDone).rejects.toThrow(/sender cancelled/i);
  }, 15000);

  it('hands out the code before storage-relay discovery', async () => {
    const pool = createMockPool();
    const data = randomBytes(4 * NOSTR_FILE_CHUNK_SIZE - 5000); // 4 chunks
    const phasesBeforeReady: string[] = [];
    let discoveringAfterReady = false;
    let ready = false;

    type Handover = { manifest: NostrFileManifest; keyBytes: Uint8Array };
    let readyResolve!: (v: Handover) => void;
    const handover = new Promise<Handover>((resolve) => {
      readyResolve = resolve;
    });
    // No dataRelayOverride: the ring resolves for real from the candidate
    // cache merged with fresh discovery. The cache still lists a signaling
    // seed — the whole DEFAULT_RELAYS pool must never be rung.
    const controlRelays = [DEFAULT_RELAYS[0], DEFAULT_RELAYS[1]];
    const storageRing = ['wss://s1.example', 'wss://s2.example'];
    const sendDone = sendFileLive(data, META, {
      pool,
      isCancelled: never,
      controlRelayOverride: controlRelays,
      storage: memoryStorage({
        candidates: [DEFAULT_RELAYS[2], ...storageRing],
        discoveredAt: Date.now(),
        cursor: 0,
      }),
      onProgress: (p) => {
        if (!ready) phasesBeforeReady.push(p.phase);
        else if (p.phase === 'discovering' || p.phase === 'health_check') {
          discoveringAfterReady = true;
        }
      },
      onReady: (m, keyBytes) => {
        ready = true;
        readyResolve({ manifest: m, keyBytes: new Uint8Array(keyBytes) });
      },
    });
    sendDone.catch(() => {});
    const { manifest, keyBytes } = await Promise.race([
      handover,
      sendDone.then<Handover>(() => {
        throw new Error('sender finished before handing over the code');
      }),
    ]);
    // Discovery had not started when the code went out.
    expect(phasesBeforeReady).not.toContain('discovering');
    expect(phasesBeforeReady).not.toContain('health_check');

    const received = await receiveFileLive(manifest, keyBytes, {
      pool,
      isCancelled: never,
      onProgress: noProgress,
    });
    await sendDone;
    expect(received).toEqual(data);
    expect(discoveringAfterReady).toBe(true);
    // The ring the receiver adopted from the avails is the resolved one:
    // every chunk landed on a storage candidate, never on a signaling relay.
    const placed = chunkPlacements(pool);
    expect(placed.size).toBe(4);
    for (const relays of placed.values()) {
      expect(relays).toHaveLength(1);
      expect(storageRing).toContain(relays[0]);
    }
  }, 15000);

  it('re-fetches a timed-out piece on its own clock, without a new announcement', async () => {
    // Scripted sender: announce the only chunk as available before the relay
    // actually serves it (late propagation), then go silent — no further
    // avails, no re-send. Only the receiver's own retry clock can recover.
    const pool = createMockPool();
    const data = randomBytes(1000); // 1 chunk
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const { secretKey, publicKey } = generateEphemeralKeys();
    const transferId = 'ab'.repeat(16);
    const createdAt = Math.floor(Date.now() / 1000);
    const manifest: NostrFileManifest = {
      v: 7,
      fileName: 'late.bin',
      fileSize: data.length,
      mimeType: 'application/octet-stream',
      fileHash: uint8ArrayToBase64(await sha256(data)),
      transferId,
      pubkey: publicKey,
      compression: 'none',
      payloadSize: data.length,
      chunkSize: 32768,
      totalChunks: 1,
      enc: 2,
      controlRelays: CONTROL_RELAYS,
      createdAt,
      expiresAt: createdAt + 3600,
    };
    const storageRelay = 'wss://s1.example';
    const controlKey = await deriveControlKey(keyBytes, transferId);
    const acks: AckMessage[] = [];
    let done = false;
    const channel = openControlChannel(pool, CONTROL_RELAYS, {
      transferId,
      key: controlKey,
      role: 'sender',
      secretKey,
      since: createdAt - 600,
      expiresAt: manifest.expiresAt,
      onMessage: (raw) => {
        const msg = parseReceiverMessage(raw, 1, 1);
        if (msg?.t === 'ack') acks.push(msg);
        if (msg?.t === 'done') done = true;
      },
    });
    try {
      await channel.send({
        t: 'avail',
        upto: 1,
        relays: [storageRelay],
        map: encodePosition(0),
        gens: [],
      });

      const receiveDone = receiveFileLive(manifest, new Uint8Array(keyBytes), {
        pool,
        isCancelled: never,
        onProgress: noProgress,
      });
      receiveDone.catch(() => {});

      // The first fetch finds nothing and the miss is reported...
      const deadline = Date.now() + 5000;
      while (!acks.some((a) => a.missing.length > 0)) {
        if (Date.now() > deadline) throw new Error('missing never reported');
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(acks.some((a) => a.missing.length > 0)).toBe(true);

      // ...now the copy lands on the announced relay. The scripted sender
      // stays silent, so only a receiver-clock re-fetch of the very same
      // placement can complete the transfer.
      const aesKey = await crypto.subtle.importKey(
        'raw',
        keyBytes as BufferSource,
        'AES-GCM',
        false,
        ['encrypt'],
      );
      const content = await encodeChunkContent(
        aesKey,
        data,
        chunkAad(transferId, 0, 1),
      );
      const event = buildChunkEvent(secretKey, {
        transferId,
        index: 0,
        total: 1,
        content,
        createdAt,
      });
      await Promise.all(pool.publish([storageRelay], event));

      const received = await receiveDone;
      expect(received).toEqual(data);
      // The verified file is handed over first; the courtesy `done` follows.
      const doneDeadline = Date.now() + 5000;
      while (!done) {
        if (Date.now() > doneDeadline) throw new Error('done never arrived');
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      channel.close();
    }
  }, 25000);

  it('rejects an expired manifest without joining the channel', async () => {
    const pool = createMockPool();
    const createdAt = Math.floor(Date.now() / 1000) - 100_000;
    const manifest: NostrFileManifest = {
      v: 7,
      fileName: 'x',
      fileSize: 10,
      mimeType: 'application/octet-stream',
      fileHash: `${'B'.repeat(43)}=`,
      transferId: 'a'.repeat(32),
      pubkey: 'c'.repeat(64),
      compression: 'none',
      payloadSize: 10,
      chunkSize: 32768,
      totalChunks: 1,
      enc: 2,
      controlRelays: CONTROL_RELAYS,
      createdAt,
      expiresAt: createdAt + 3600,
    };
    await expect(
      receiveFileLive(manifest, new Uint8Array(32), {
        pool,
        isCancelled: never,
        onProgress: noProgress,
      }),
    ).rejects.toThrow(/expired/);
    expect(pool.store.size).toBe(0);
  });
});
