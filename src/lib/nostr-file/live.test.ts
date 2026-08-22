import type { Event } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAYS } from '../nostr/relays';
import { LIVE_BATCH_CHUNKS } from './constants';
import { type LiveReceiveProgress, receiveFileLive } from './download-live';
import type { NostrFileManifest } from './manifest';
import { createMockPool, type MockPool } from './mock-pool';
import type { RelayPoolState, RelayPoolStorage } from './relay-pool';
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
const META = { fileName: 'live.bin', mimeType: 'application/octet-stream' };
const never = () => false;
const noProgress = () => {};

function memoryStorage(): RelayPoolStorage {
  let state: RelayPoolState | null = null;
  return {
    get: () => state,
    set(s) {
      state = s;
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

  const sendDone = sendFileLive(data, META, {
    pool,
    isCancelled: opts.senderCancelled ?? never,
    controlRelayOverride: CONTROL_RELAYS,
    dataRelayOverride: opts.relays ?? RELAYS,
    onProgress: opts.onSend ?? noProgress,
    onReady: (m, keyBytes) =>
      readyResolve({ manifest: m, keyBytes: new Uint8Array(keyBytes) }),
  });
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
    const data = randomBytes(100_000); // 4 chunks
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
  });

  it('re-sends only the pieces the receiver could not fetch, to the next relay', async () => {
    // r2 acknowledges uploads but never serves them: every chunk placed
    // there is reported missing by the receiver and must be re-sent.
    const pool = createMockPool({
      blackholeRelays: new Set(['wss://r2.example']),
    });
    const data = randomBytes(200_000); // 7 chunks: 1, 4 land on r2 first
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
    const data = randomBytes(chunks * 32768 - 10);
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
    const data = randomBytes(chunks * 32768 - 100);
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
    const data = randomBytes(100_000); // 4 chunks: 0 and 3 would go to r1
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
    const data = randomBytes(400_000); // 13 chunks
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
    const data = randomBytes(100_000); // 4 chunks
    const phasesBeforeReady: string[] = [];
    let discoveringAfterReady = false;
    let ready = false;

    type Handover = { manifest: NostrFileManifest; keyBytes: Uint8Array };
    let readyResolve!: (v: Handover) => void;
    const handover = new Promise<Handover>((resolve) => {
      readyResolve = resolve;
    });
    // No dataRelayOverride: discovery runs for real and degrades to the
    // DEFAULT_RELAYS seeds, which the mock pool all passes.
    const sendDone = sendFileLive(data, META, {
      pool,
      isCancelled: never,
      controlRelayOverride: CONTROL_RELAYS,
      storage: memoryStorage(),
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
    // The ring the receiver adopted from the avails is the discovered one:
    // every chunk landed on a seed relay, none on the control relays.
    const placed = chunkPlacements(pool);
    expect(placed.size).toBe(4);
    for (const relays of placed.values()) {
      expect(relays).toHaveLength(1);
      expect(DEFAULT_RELAYS).toContain(relays[0]);
    }
  }, 15000);

  it('rejects an expired manifest without joining the channel', async () => {
    const pool = createMockPool();
    const createdAt = Math.floor(Date.now() / 1000) - 100_000;
    const manifest: NostrFileManifest = {
      v: 4,
      fileName: 'x',
      fileSize: 10,
      mimeType: 'application/octet-stream',
      fileHash: `${'B'.repeat(43)}=`,
      transferId: 'a'.repeat(32),
      pubkey: 'c'.repeat(64),
      chunkSize: 32768,
      totalChunks: 1,
      enc: 1,
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
