import { generatePin } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import { t } from '@/lib/i18n';
import type { TransferMetadata, TransferState } from '@/lib/nostr/types';
import { formatOnionAddress, TOR_DEFAULT_PORT } from '@/lib/tor/onion-address';
import { serveUntilSent } from '@/lib/tor/serve';
import {
  TOR_MAX_TRANSFER_BYTES,
  TOR_MAX_WIRE_BYTES,
  TOR_SUGGESTED_MAX_BYTES,
} from '@/lib/tor/transfer';
import type { OnionService, WebtorClient } from '@/lib/tor/webtor-api';
import type { TransferSource } from '@/lib/transfer-source';
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
    const max = formatFileSize(TOR_MAX_TRANSFER_BYTES);
    const size = formatFileSize(content.estimatedSize);
    return t({
      en: `The Tor transport carries at most ${max}; ${content.name} is ${size}`,
      es: `El transporte por Tor lleva como máximo ${max}; ${content.name} ocupa ${size}`,
    });
  }
  if (content.projectedWireBytes > TOR_MAX_WIRE_BYTES) {
    const wire = formatFileSize(content.projectedWireBytes);
    const max = formatFileSize(TOR_MAX_WIRE_BYTES);
    return t({
      en: `${content.name} needs up to ${wire} on the wire, over the ${max} the Tor transport allows`,
      es: `${content.name} necesita hasta ${wire} en la red, más de los ${max} que permite el transporte por Tor`,
    });
  }
  return null;
}

/** A word about a transfer big enough to be worth one, or null. */
export function torSendCaution(content: TransferSource): string | null {
  if (content.estimatedSize <= TOR_SUGGESTED_MAX_BYTES) return null;
  const size = formatFileSize(content.estimatedSize);
  return t({
    en: `${content.name} is ${size}. Throughput over a circuit is unpredictable, and a transfer that drops starts over.`,
    es: `${content.name} ocupa ${size}. La velocidad por un circuito es impredecible, y una transferencia que se corta empieza de nuevo.`,
  });
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

  // The engine's steps are a status, the same as Code Exchange's: the
  // presenter is what replaces one with the next, and what keeps a step that
  // only ticks its numbers from filling the screen.
  const setState = (state: TransferState) => {
    if (state.status === 'transferring' && state.progress) {
      presenter.progress(state.progress.current, state.progress.total);
      return;
    }
    if (state.message) presenter.status(state.message);
  };

  try {
    client = await bootstrapTor({
      ...torOptions,
      verbose,
      say,
    });
    say(
      t({
        en: 'Publishing the onion service...',
        es: 'Publicando el servicio onion...',
      }),
    );
    service = await client.publishOnionService();

    // Two strings out of one address: `onion` is what the handshake binds and
    // always carries the port, while what the receiver is handed leaves the
    // port implicit.
    const onion = `${service.onionAddress}:${TOR_DEFAULT_PORT}`;
    const password = generatePin();
    say('');
    say(
      t({
        en: 'Give the receiver this address and password:',
        es: 'Dale al receptor esta dirección y esta contraseña:',
      }),
    );
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
    say(t({ en: `Sent ${content.name}`, es: `Enviado ${content.name}` }));
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
