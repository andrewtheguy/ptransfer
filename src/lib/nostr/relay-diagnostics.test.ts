import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_KIND_FILE_CHUNK } from '../nostr-file/constants';
import { probeSignalingRelay, probeSignalingRelays } from './relay-diagnostics';
import { EVENT_KIND_DATA_TRANSFER, EVENT_KIND_RENDEZVOUS } from './types';

type Frame = [string, ...unknown[]];
type StoredEvent = { id: string; kind: number; content: string };

/**
 * A scriptable relay: `behaviour` decides how it answers each published
 * event, so one test can be a working relay and the next one that accepts the
 * connection and then refuses a kind — the distinction the probe exists to
 * draw, and the one a connect-only check cannot make. `accept` and
 * `serveReadBack` take the kind, because a relay refusing one kind while
 * serving another is exactly what makes the two checks disagree.
 */
class FakeRelay {
  static instances: FakeRelay[] = [];
  static behaviour: {
    open?: boolean;
    closeCode?: number;
    closeReason?: string;
    accept?: (kind: number) => { ok: boolean; reason?: string };
    serveReadBack?: (kind: number) => boolean;
    alterServedContent?: boolean;
  } = {};

  url: string;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  private published: StoredEvent[] = [];

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
      const event = frame[1] as StoredEvent;
      const verdict = FakeRelay.behaviour.accept?.(event.kind) ?? { ok: true };
      if (verdict.ok) this.published.push(event);
      this.reply(['OK', event.id, verdict.ok, verdict.reason ?? '']);
    } else if (type === 'REQ') {
      const subscription = frame[1] as string;
      const [kind] = (frame[2] as { kinds: number[] }).kinds;
      const stored = this.published.find((event) => event.kind === kind);
      if (stored && (FakeRelay.behaviour.serveReadBack?.(kind) ?? true)) {
        this.reply([
          'EVENT',
          subscription,
          FakeRelay.behaviour.alterServedContent
            ? { ...stored, content: `${stored.content}tampered` }
            : stored,
        ]);
      }
      this.reply(['EOSE', subscription]);
    }
  }

  close(): void {}
}

const RELAY = 'wss://relay.example';

const stubs = () => {
  FakeRelay.instances = [];
  FakeRelay.behaviour = {};
  vi.stubGlobal('WebSocket', FakeRelay);
  // The NIP-11 fallback only runs for a relay that already failed to
  // connect; unless a test says otherwise the host is simply not there.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('unreachable'))),
  );
};

describe('probeSignalingRelay', () => {
  beforeEach(stubs);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes both checks against a relay that takes every kind and serves it back', async () => {
    const result = await probeSignalingRelay(RELAY);
    expect(result.connect.status).toBe('ok');
    expect(result.pinExchange.passed).toBe(true);
    expect(result.codeExchange.passed).toBe(true);
    expect(result.pinExchange.rttMs).not.toBeNull();
    expect(result.codeExchange.rttMs).not.toBeNull();
    for (const check of [result.pinExchange, result.codeExchange]) {
      expect(check.steps.map((step) => step.status)).not.toContain('failed');
    }
  });

  it('publishes all three production kinds under one throwaway key', async () => {
    await probeSignalingRelay(RELAY);
    const events = FakeRelay.instances[0].sent
      .filter(([type]) => type === 'EVENT')
      .map(([, event]) => event as { kind: number; pubkey: string });
    expect(events.map((event) => event.kind).sort((a, b) => a - b)).toEqual([
      EVENT_KIND_RENDEZVOUS,
      EVENT_KIND_DATA_TRANSFER,
      EVENT_KIND_FILE_CHUNK,
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

  // The case that motivates the split: one relay, two verdicts. A kind
  // allowlist that omits the signaling kinds still carries Code Exchange's
  // control channel perfectly well, and a single verdict would have to lie
  // about one of them.
  it('separates the verdicts when a relay takes one method and refuses the other', async () => {
    FakeRelay.behaviour = {
      accept: (kind) =>
        kind === EVENT_KIND_FILE_CHUNK
          ? { ok: true }
          : { ok: false, reason: `kind ${kind} not permitted in this relay` },
    };
    const result = await probeSignalingRelay(RELAY);
    expect(result.connect.status).toBe('ok');
    expect(result.pinExchange.passed).toBe(false);
    expect(result.codeExchange.passed).toBe(true);
    const [writeRendezvous] = result.pinExchange.steps;
    expect(writeRendezvous.detail).toBe(
      `kind ${EVENT_KIND_RENDEZVOUS} not permitted in this relay`,
    );
  });

  it('separates them the other way round too', async () => {
    FakeRelay.behaviour = {
      accept: (kind) =>
        kind === EVENT_KIND_FILE_CHUNK
          ? { ok: false, reason: 'chunk kind not permitted' }
          : { ok: true },
    };
    const result = await probeSignalingRelay(RELAY);
    expect(result.pinExchange.passed).toBe(true);
    expect(result.codeExchange.passed).toBe(false);
    const [writeControl, readControl] = result.codeExchange.steps;
    expect(writeControl.detail).toBe('chunk kind not permitted');
    // Nothing landed, so the read had nothing to prove — not a second failure.
    expect(readControl.status).toBe('skipped');
    expect(readControl.detail).toBe('the write was refused');
  });

  it('fails the check whose write was acknowledged and then not served', async () => {
    FakeRelay.behaviour = {
      serveReadBack: (kind) => kind !== EVENT_KIND_RENDEZVOUS,
    };
    const result = await probeSignalingRelay(RELAY);
    expect(result.pinExchange.passed).toBe(false);
    expect(result.codeExchange.passed).toBe(true);
    const readRendezvous = result.pinExchange.steps[2];
    expect(readRendezvous.status).toBe('failed');
    expect(readRendezvous.detail).toBe('acknowledged but not served');
  });

  it('fails the control check when the relay serves back altered content', async () => {
    FakeRelay.behaviour = { alterServedContent: true };
    const result = await probeSignalingRelay(RELAY);
    expect(result.codeExchange.passed).toBe(false);
    const readControl = result.codeExchange.steps[1];
    expect(readControl.status).toBe('failed');
    expect(readControl.detail).toBe('served altered content');
  });

  // One problem must read as one problem: a relay that never opened has not
  // refused anything, so every later step is 'not attempted', not a failure.
  it('reports an unreachable relay as a single connect failure', async () => {
    FakeRelay.behaviour = { open: false, closeReason: 'TLS handshake failed' };
    const result = await probeSignalingRelay(RELAY);
    expect(result.connect.status).toBe('failed');
    // A reason the socket actually gave is kept; only the HTTPS verdict is
    // appended to it.
    expect(result.connect.detail).toContain('TLS handshake failed');
    expect(result.pinExchange.passed).toBe(false);
    expect(result.codeExchange.passed).toBe(false);
    for (const check of [result.pinExchange, result.codeExchange]) {
      for (const step of check.steps) {
        expect(step.status).toBe('skipped');
        expect(step.detail).toBe('not attempted');
      }
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
    expect(result.connect.detail).toBe(
      'WebSocket refused · host answers HTTPS 503',
    );
  });

  it('says so when the host cannot be reached over HTTPS either', async () => {
    FakeRelay.behaviour = { open: false, closeCode: 1006, closeReason: '' };
    const result = await probeSignalingRelay(RELAY);
    expect(result.connect.detail).toBe(
      'WebSocket refused · host unreachable over HTTPS too (DNS, TLS, or blocked)',
    );
  });

  it('does not ask HTTPS about a relay that connected fine', async () => {
    await probeSignalingRelay(RELAY);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('probeSignalingRelays', () => {
  beforeEach(stubs);
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
