import { join } from 'node:path';
import type { AppendSink } from '@/lib/append-sink';
import { isValidPin } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import { TorFramedStream } from '@/lib/tor/framing';
import {
  runTorClientHandshake,
  sendCancel,
  sendReady,
} from '@/lib/tor/handshake';
import type { OnionAddress } from '@/lib/tor/onion-address';
import { receiveFileOverTor, TOR_MAX_TRANSFER_BYTES } from '@/lib/tor/transfer';
import type { WebtorClient } from '@/lib/tor/webtor-api';
import { onInterrupt } from '../interrupt';
import { bootstrapTor, closeTor, type TorOptions } from '../tor/bootstrap';
import type { Presenter } from '../ui/presenter';
import { UsageError } from '../usage';
import { createFileSink, safeFileName } from './files';

/**
 * Receiving from a Tor onion service, the counterpart of the tab's
 * `useTorReceive`: a circuit to the address the sender published, the one-time
 * password through the same SPAKE2 exchange, and the file saved under the name
 * the sender gave it.
 *
 * The password is asked for rather than taken from a flag: a flag would leave
 * it in shell history and in the process list.
 */
export interface TorReceiveOptions {
  /** The address the sender showed, already parsed. */
  parsed: OnionAddress;
  /** The folder the file is saved in, already checked. */
  folder: string;
  torOptions: TorOptions;
  verbose: boolean;
  presenter: Presenter;
}

export async function receiveOverTor(
  options: TorReceiveOptions,
): Promise<number> {
  const { parsed, folder, torOptions, verbose, presenter } = options;
  const say = (line: string) => presenter.say(line);
  const password = await presenter.readSecret('Password: ');
  if (!isValidPin(password)) {
    throw new UsageError('That is not a valid password; check for typos');
  }

  // The status of the signal that stopped the command, once one has.
  let interrupted: number | null = null;
  let client: WebtorClient | null = null;
  let framed: TorFramedStream | null = null;
  // Held here rather than left to receiveFileOverTor, which owns it only once
  // it runs: a failure before that, or Ctrl-C, still removes the part file.
  // A finished sink is the saved file and has nothing to discard.
  let sink: AppendSink | null = null;
  const teardown = async () => {
    const closingStream = framed;
    const closingClient = client;
    const abandonedSink = sink;
    framed = null;
    client = null;
    sink = null;
    await closingStream?.close();
    await abandonedSink?.discard().catch(() => undefined);
    await closeTor(closingClient);
  };
  const uninstall = onInterrupt((status) => {
    interrupted = status;
    return teardown();
  });

  try {
    client = await bootstrapTor({ ...torOptions, verbose, say });
    say(`Building a circuit to ${parsed.host}...`);
    const stream = await client.connectStream(parsed.host, parsed.port);
    framed = new TorFramedStream(stream);

    say('Authenticating...');
    const { keys, metadata } = await runTorClientHandshake(
      framed,
      password,
      parsed.onion,
    );
    // fileSize is the sender's input size — a progress hint that bounds
    // nothing on the wire — but a sender offering more than the limit is not
    // worth connecting a transfer for.
    if (metadata.fileSize > TOR_MAX_TRANSFER_BYTES) {
      throw new Error(
        `The sender is offering ${formatFileSize(metadata.fileSize)}, over the ${formatFileSize(TOR_MAX_TRANSFER_BYTES)} limit of the Tor transport`,
      );
    }

    // A destination conflict is the receiver's problem, not the sender's:
    // declining leaves the service waiting, so this side can move the file
    // out of the way and come back.
    const destination = join(folder, safeFileName(metadata.fileName));
    let fileSink: AppendSink;
    try {
      fileSink = await createFileSink(destination);
    } catch (error) {
      await sendCancel(framed);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; move it aside and receive again — the sender is still waiting`,
      );
    }
    sink = fileSink;

    say(
      `Receiving ${metadata.fileName} (${formatFileSize(metadata.fileSize)})...`,
    );
    await sendReady(framed);
    const payload = await receiveFileOverTor(
      framed,
      keys.contentKey,
      metadata.contentEncoding,
      fileSink,
      {
        estimatedBytes: metadata.fileSize,
        isCancelled: () => interrupted !== null,
        onProgress: (current, total) => presenter.progress(current, total),
      },
    );
    presenter.done();
    // The file is whole: hanging up is the receiver's only word.
    await framed.close();
    say(`Saved ${formatFileSize(payload.size)} to ${destination}`);
    presenter.hand(destination);
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
