import { generatePin } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferMetadata, TransferState } from '@/lib/nostr/types';
import { formatOnionAddress, TOR_DEFAULT_PORT } from '@/lib/tor/onion-address';
import { serveUntilSent } from '@/lib/tor/serve';
import {
  TOR_MAX_TRANSFER_BYTES,
  TOR_MAX_WIRE_BYTES,
  TOR_SUGGESTED_MAX_BYTES,
} from '@/lib/tor/transfer';
import type { OnionService, WebtorClient } from '@/lib/tor/webtor-api';
import { type TransferSource, wireEncodingFor } from '@/lib/transfer-source';
import { onInterrupt } from '../interrupt';
import { bootstrapTor, closeTor, type TorOptions } from '../tor/bootstrap';
import type { Presenter } from '../ui/presenter';

/**
 * Sending over a Tor onion service, the counterpart of the tab's `useTorSend`:
 * the same accept loop on the same `src/lib/tor` code, the same bounds.
 *
 * An ephemeral v3 service is published for one transfer, and the address and
 * the one-time password it answers to are handed over for the receiver to
 * carry. It answers until a receiver takes the transfer, or until
 * `serveUntilSent` gives up waiting.
 */
export interface TorSendOptions {
  content: TransferSource;
  torOptions: TorOptions;
  verbose: boolean;
  presenter: Presenter;
}

/** Why this selection cannot go over Tor, or null when it can. */
export function torSendRefusal(content: TransferSource): string | null {
  if (content.estimatedSize > TOR_MAX_TRANSFER_BYTES) {
    return `The Tor transport carries at most ${formatFileSize(TOR_MAX_TRANSFER_BYTES)}; ${content.name} is ${formatFileSize(content.estimatedSize)}`;
  }
  if (content.projectedWireBytes > TOR_MAX_WIRE_BYTES) {
    return `${content.name} needs up to ${formatFileSize(content.projectedWireBytes)} on the wire, over the ${formatFileSize(TOR_MAX_WIRE_BYTES)} the Tor transport allows`;
  }
  return null;
}

/** A word about a transfer big enough to be worth one, or null. */
export function torSendCaution(content: TransferSource): string | null {
  if (content.estimatedSize <= TOR_SUGGESTED_MAX_BYTES) return null;
  return `${content.name} is ${formatFileSize(content.estimatedSize)}. Throughput over a circuit is unpredictable, and a transfer that drops starts over.`;
}

export async function sendOverTor(options: TorSendOptions): Promise<number> {
  const { content, torOptions, verbose, presenter } = options;
  const say = (line: string) => presenter.say(line);
  const refusal = torSendRefusal(content);
  if (refusal) throw new Error(refusal);
  const caution = torSendCaution(content);
  if (caution) say(caution);

  const fileMetadata = {
    fileName: content.name,
    fileSize: content.estimatedSize,
    mimeType: content.type,
  };

  // The status of the signal that stopped the command, once one has.
  let interrupted: number | null = null;
  let client: WebtorClient | null = null;
  let service: OnionService | null = null;
  const teardown = async () => {
    const closingService = service;
    const closingClient = client;
    service = null;
    client = null;
    await closingService?.close().catch(() => undefined);
    await closeTor(closingClient);
  };
  const uninstall = onInterrupt((status) => {
    interrupted = status;
    return teardown();
  });

  let lastMessage = '';
  const setState = (state: TransferState) => {
    if (state.status === 'transferring' && state.progress) {
      presenter.progress(state.progress.current, state.progress.total);
      return;
    }
    if (state.message && state.message !== lastMessage) {
      say(state.message);
      lastMessage = state.message;
    }
  };

  try {
    client = await bootstrapTor({
      ...torOptions,
      verbose,
      say,
    });
    say('Publishing the onion service...');
    service = await client.publishOnionService();

    // Two strings out of one address: `onion` is what the handshake binds and
    // always carries the port, while what the receiver is handed leaves the
    // port implicit.
    const onion = `${service.onionAddress}:${TOR_DEFAULT_PORT}`;
    const password = generatePin();
    say('');
    say('Give the receiver this address and password:');
    say('');
    presenter.hand(
      formatOnionAddress(service.onionAddress, TOR_DEFAULT_PORT),
      'address',
    );
    presenter.hand(password, 'password');
    say('');

    const metadata: TransferMetadata = {
      contentType: 'file',
      fileName: fileMetadata.fileName,
      fileSize: fileMetadata.fileSize,
      contentEncoding: wireEncodingFor(content),
      mimeType: fileMetadata.mimeType,
    };
    await serveUntilSent({
      service,
      onion,
      password,
      metadata,
      content,
      fileMetadata,
      isCancelled: () => interrupted !== null,
      setState,
    });
    presenter.done();
    say(`Sent ${content.name}`);
    return 0;
  } catch (error) {
    presenter.done();
    if (interrupted !== null) return interrupted;
    throw error;
  } finally {
    uninstall();
    await teardown();
  }
}
