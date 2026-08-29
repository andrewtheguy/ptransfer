import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeSignalingRelay, probeSignalingRelays } from './relay-diagnostics';
import { EVENT_KIND_DATA_TRANSFER, EVENT_KIND_RENDEZVOUS } from './types';

type Frame = [string, ...unknown[]];

/**
 * A scriptable relay: `behaviour` decides how it answers each published
 * event, so one test can be a working relay and the next one that accepts the
 * connection and then refuses the kinds — the distinction the probe exists to
 * draw, and the one a connect-only check cannot make.
 */
class FakeRelay {
  static instances: FakeRelay[] = [];
  static behaviour: {
    open?: boolean;
    closeCode?: number;
    closeReason?: string;
    accept?: (kind: number) => { ok: boolean; reason?: string };
    serveReadBack?: boolean;
  } = {};

  url: string;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  private published: { id: string; kind: number }[] = [];

  constructor(url: string | URL) {
    this.url = String(url);
    FakeRelay.instances.push(this);
    queueMicrotask(() => {
      if (FakeRelay.behaviour.open === false) {
        this.onerror?.({});
        this.onclose?.({
          code: FakeRelay.behaviour.closeCode ?? 1002,
          reason: FakeRelay.behaviour.closeReason ?? '',
        });
        return;
      }
      this.onopen?.();
    });
  }

  private reply(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as Frame;
    this.sent.push(frame);
    const [type] = frame;
    if (type === 'EVENT') {
      const event = frame[1] as { id: string; kind: number };
      const verdict = FakeRelay.behaviour.accept?.(event.kind) ?? { ok: true };
      if (verdict.ok) this.published.push(event);
      this.reply(['OK', event.id, verdict.ok, verdict.reason ?? '']);
    } else if (type === 'REQ') {
      const subscription = frame[1] as string;
      if (FakeRelay.behaviour.serveReadBack !== false) {
        const stored = this.published.find(
          (event) => event.kind === EVENT_KIND_RENDEZVOUS,
        );
        if (stored) this.reply(['EVENT', subscription, stored]);
      }
      this.reply(['EOSE', subscription]);
    }
  }

  close(): void {}
}

const RELAY = 'wss://relay.example';

describe('probeSignalingRelay', () => {
  beforeEach(() => {
    FakeRelay.instances = [];
    FakeRelay.behaviour = {};
    vi.stubGlobal('WebSocket', FakeRelay);
    // The NIP-11 fallback only runs for a relay that already failed to
    // connect; unless a test says otherwise the host is simply not there.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unreachable'))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes a relay that accepts both kinds and serves the rendezvous back', async () => {
    const result = await probeSignalingRelay(RELAY);
    expect(result.healthy).toBe(true);
    expect(result.rttMs).not.toBeNull();
    expect(result.steps.map((step) => step.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
  });

  it('publishes both signaling kinds under one throwaway key', async () => {
    await probeSignalingRelay(RELAY);
    const events = FakeRelay.instances[0].sent
      .filter(([type]) => type === 'EVENT')
      .map(([, event]) => event as { kind: number; pubkey: string });
    expect(events.map((event) => event.kind).sort((a, b) => a - b)).toEqual([
      EVENT_KIND_RENDEZVOUS,
      EVENT_KIND_DATA_TRANSFER,
    ]);
    expect(new Set(events.map((event) => event.pubkey)).size).toBe(1);
  });

  it('bounds the rendezvous it leaves behind with a NIP-40 expiration', async () => {
    await probeSignalingRelay(RELAY);
    const [, rendezvous] = FakeRelay.instances[0].sent.find(
      ([type, event]) =>
        type === 'EVENT' &&
        (event as { kind: number }).kind === EVENT_KIND_RENDEZVOUS,
    ) as [string, { created_at: number; tags: string[][] }];
    const expiration = rendezvous.tags.find(([tag]) => tag === 'expiration');
    expect(expiration).toBeDefined();
    expect(Number(expiration?.[1])).toBeGreaterThan(rendezvous.created_at);
  });

  // The case that motivates the whole probe: the socket opens, so any
  // reachability check calls this relay healthy, and signaling can never work.
  it('fails a relay that opens but refuses the signaling kinds', async () => {
    FakeRelay.behaviour = {
      accept: (kind) => ({
        ok: false,
        reason: `kind ${kind} not permitted in this relay`,
      }),
    };
    const result = await probeSignalingRelay(RELAY);
    expect(result.healthy).toBe(false);
    expect(result.rttMs).toBeNull();
    const [connect, writeRendezvous] = result.steps;
    expect(connect.status).toBe('ok');
    expect(writeRendezvous.status).toBe('failed');
    expect(writeRendezvous.detail).toBe(
      `kind ${EVENT_KIND_RENDEZVOUS} not permitted in this relay`,
    );
  });

  it('fails a relay that acknowledges the write and then does not serve it', async () => {
    FakeRelay.behaviour = { serveReadBack: false };
    const result = await probeSignalingRelay(RELAY);
    expect(result.healthy).toBe(false);
    const readBack = result.steps[3];
    expect(readBack.status).toBe('failed');
    expect(readBack.detail).toBe('acknowledged but not served');
  });

  // One problem must read as one problem: a relay that never opened has not
  // refused anything, so the later steps are 'not attempted', not failures.
  it('reports an unreachable relay as a single connect failure', async () => {
    FakeRelay.behaviour = { open: false, closeReason: 'TLS handshake failed' };
    const result = await probeSignalingRelay(RELAY);
    expect(result.healthy).toBe(false);
    const [connect, ...rest] = result.steps;
    expect(connect.status).toBe('failed');
    // A reason the socket actually gave is kept; only the HTTPS verdict is
    // appended to it.
    expect(connect.detail).toContain('TLS handshake failed');
    for (const step of rest) {
      expect(step.status).toBe('skipped');
      expect(step.detail).toBe('not attempted');
    }
  });

  // Browsers give page script nothing but close code 1006, so without this
  // fallback the page would report every network failure identically.
  it('asks the relay over HTTPS why the socket failed', async () => {
    FakeRelay.behaviour = { open: false, closeCode: 1006, closeReason: '' };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ status: 503 } as Response)),
    );
    const result = await probeSignalingRelay(RELAY);
    expect(fetch).toHaveBeenCalledWith(
      'https://relay.example/',
      expect.objectContaining({
        headers: { Accept: 'application/nostr+json' },
      }),
    );
    // The host is up and refusing the upgrade — not the same problem as a
    // host that cannot be reached at all.
    expect(result.steps[0].detail).toBe(
      'WebSocket refused · host answers HTTPS 503',
    );
  });

  it('says so when the host cannot be reached over HTTPS either', async () => {
    FakeRelay.behaviour = { open: false, closeCode: 1006, closeReason: '' };
    const result = await probeSignalingRelay(RELAY);
    expect(result.steps[0].detail).toBe(
      'WebSocket refused · host unreachable over HTTPS too (DNS, TLS, or blocked)',
    );
  });

  it('does not ask HTTPS about a relay that connected fine', async () => {
    await probeSignalingRelay(RELAY);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('probeSignalingRelays', () => {
  beforeEach(() => {
    FakeRelay.instances = [];
    FakeRelay.behaviour = {};
    vi.stubGlobal('WebSocket', FakeRelay);
    // The NIP-11 fallback only runs for a relay that already failed to
    // connect; unless a test says otherwise the host is simply not there.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unreachable'))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports every relay it was given, canonicalized and deduplicated', async () => {
    const results = await probeSignalingRelays([
      'wss://a.example',
      'wss://a.example/',
      'wss://b.example',
    ]);
    expect(results.map((result) => result.url)).toEqual([
      'wss://a.example',
      'wss://b.example',
    ]);
  });

  it('drops anything that is not a usable clearnet relay URL', async () => {
    const results = await probeSignalingRelays([
      'wss://a.example',
      // An onion relay needs Tor, and probing it here would open the very
      // clearnet socket anonymous signaling exists to avoid.
      'ws://oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion',
      'http://a.example',
    ]);
    expect(results.map((result) => result.url)).toEqual(['wss://a.example']);
  });
});
