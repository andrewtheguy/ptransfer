import { type Event, type Filter, matchFilters } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  computePinHintFromLocator,
  deriveHandshakeSealKeys,
  derivePakeSecret,
  finishPake,
  generatePin,
  generateSalt,
  generateTransferId,
  getPinBucket,
  getPinLocator,
  MAX_TRANSFER_BYTES,
  startPake,
} from '@/lib/crypto';
import {
  base64ToUint8Array,
  computeRendezvousTranscriptHash,
  createHandshakeEvent,
  createRendezvousEvent,
  EVENT_KIND_RENDEZVOUS,
  generateEphemeralKeys,
  type NostrClient,
  parseRendezvousEvent,
  type RendezvousPayload,
  sealHandshakePayload,
  uint8ArrayToBase64,
} from '@/lib/nostr';
import { PROTOCOL_VERSION } from '@/lib/protocol-version';
import { claimPin } from './receive';
import { startPinRendezvous } from './send';

/**
 * A peer on another protocol is refused by name, not left to time out.
 *
 * The other peer is built by hand the way an older release builds it — the
 * same handshake, no `protocolVersion` — so these hold only while that older
 * peer's claim still routes and its rendezvous still parses.
 */

/** One relay in memory: what is published is stored, and delivered to every matching subscription. */
function memoryRelay() {
  const events: Event[] = [];
  const subscriptions = new Map<
    string,
    { filters: Filter[]; onEvent: (event: Event) => void }
  >();
  let next = 0;
  const client = {
    publish(event: Event): Promise<void> {
      events.push(event);
      for (const { filters, onEvent } of subscriptions.values()) {
        if (matchFilters(filters, event)) queueMicrotask(() => onEvent(event));
      }
      return Promise.resolve();
    },
    subscribe(filters: Filter[], onEvent: (event: Event) => void) {
      const id = `sub-${next++}`;
      subscriptions.set(id, { filters, onEvent });
      return id;
    },
    unsubscribe(id: string) {
      subscriptions.delete(id);
    },
    query(filters: Filter[]): Promise<Event[]> {
      return Promise.resolve(
        events.filter((event) => matchFilters(filters, event)),
      );
    },
  };
  return { events, client: client as unknown as NostrClient };
}

describe('PIN Exchange across protocol versions', () => {
  it('the sender refuses a claim from a receiver that sends no version', async () => {
    const relay = memoryRelay();
    let shown!: (pin: string) => void;
    const pinShown = new Promise<string>((resolve) => {
      shown = resolve;
    });
    const session = startPinRendezvous({
      client: relay.client,
      pinKind: 'standard',
      relays: [],
      isCancelled: () => false,
      onPin: (pin) => shown(pin),
    });
    try {
      const pin = await pinShown;
      const published = relay.events.find(
        (event) => event.kind === EVENT_KIND_RENDEZVOUS,
      );
      const rendezvous = published && parseRendezvousEvent(published);
      if (!rendezvous) throw new Error('No rendezvous was published');
      const payload = rendezvous.payload as RendezvousPayload;

      // An older receiver's claim: the same PAKE, seal and routing target,
      // with no version in its body.
      const pakeSecret = await derivePakeSecret(pin);
      const receiver = generateEphemeralKeys();
      const run = startPake('receiver', pakeSecret);
      const rootKey = await finishPake(
        'receiver',
        run.secret,
        pakeSecret,
        run.message,
        base64ToUint8Array(payload.pakeMessage),
        {
          transferId: payload.transferId,
          senderPubkey: payload.senderPubkey,
          receiverPubkey: receiver.publicKey,
        },
      );
      const { claimKey } = await deriveHandshakeSealKeys(
        rootKey,
        rendezvous.salt,
      );
      // Hashed as a release that has never heard of the field: without it.
      const { protocolVersion: _unknown, ...seen } = payload;
      const transcriptHash = await computeRendezvousTranscriptHash(
        seen as RendezvousPayload,
        rendezvous.salt,
      );
      await relay.client.publish(
        createHandshakeEvent(
          receiver.secretKey,
          payload.senderPubkey,
          payload.transferId,
          'claim',
          await sealHandshakePayload(claimKey, {
            type: 'claim',
            transferId: payload.transferId,
            senderNonce: payload.nonce,
            receiverNonce: 'cmVjZWl2ZXItbm9uY2UtMDAwMDA=',
            senderPubkey: payload.senderPubkey,
            receiverPubkey: receiver.publicKey,
            transcriptHash,
          }),
          run.message,
          transcriptHash,
        ),
      );

      await expect(session.claimed).rejects.toThrow(
        `The receiver is running a pTransfer release on an older protocol, and this one is on protocol ${PROTOCOL_VERSION}.`,
      );
    } finally {
      session.close();
    }
  });

  it('the receiver refuses a rendezvous from a sender that sends no version', async () => {
    const relay = memoryRelay();
    const pin = generatePin('standard');
    const bucket = getPinBucket();
    const sender = generateEphemeralKeys();
    const transferId = generateTransferId();
    const run = startPake('sender', await derivePakeSecret(pin));
    // An older sender's rendezvous: every field but the version.
    const payload = {
      type: 'rendezvous',
      transferId,
      senderPubkey: sender.publicKey,
      pakeMessage: uint8ArrayToBase64(run.message),
      nonce: 'c2VuZGVyLW5vbmNlLTAwMDAwMDA=',
      relays: [],
    } as unknown as RendezvousPayload;
    await relay.client.publish(
      createRendezvousEvent(
        sender.secretKey,
        payload,
        generateSalt(),
        await computePinHintFromLocator(getPinLocator(pin), bucket),
        bucket,
      ),
    );

    await expect(
      claimPin({
        client: relay.client,
        pakeSecret: await derivePakeSecret(pin),
        locator: getPinLocator(pin),
        maxTransferBytes: MAX_TRANSFER_BYTES,
        isCancelled: () => false,
        report: () => {},
      }),
    ).rejects.toThrow(
      `The sender is running a pTransfer release on an older protocol, and this one is on protocol ${PROTOCOL_VERSION}.`,
    );
  });
});
