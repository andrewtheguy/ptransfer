import { parseArgs } from 'node:util';
import { generatePin } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import type { TransferMetadata, TransferState } from '@/lib/nostr/types';
import { formatOnionAddress, TOR_DEFAULT_PORT } from '@/lib/tor/onion-address';
import { serveUntilSent, TOR_WAIT_TIMEOUT_MS } from '@/lib/tor/serve';
import {
  TOR_MAX_TRANSFER_BYTES,
  TOR_MAX_WIRE_BYTES,
  TOR_SUGGESTED_MAX_BYTES,
} from '@/lib/tor/transfer';
import type { OnionService, WebtorClient } from '@/lib/tor/webtor-api';
import { wireEncodingFor } from '@/lib/transfer-source';
import { routeDiagnostics } from '../diagnostics';
import { onInterrupt } from '../interrupt';
import { createProgressLine } from '../progress';
import {
  bootstrapTor,
  closeTor,
  TOR_OPTIONS,
  TOR_OPTIONS_USAGE,
  torOptionsFrom,
} from '../tor/bootstrap';
import { openFileSource } from '../transfer/files';
import { UsageError } from '../usage';

/**
 * `ptransfer send --tor <file>`: publish an ephemeral v3 onion service that
 * serves one file, and print the address and one-time password the receiver
 * needs. The counterpart of the tab's `useTorSend`: the same accept loop, the
 * same bounds, with the terminal for a screen.
 *
 * The address and password go to standard output, one per line, so a script
 * can take them; everything else goes to standard error.
 */

const USAGE = `usage: ptransfer send --tor <file> [options]

Publish an onion service that serves one file, and print the address and the
one-time password the receiver needs. The service answers until a receiver
takes the file, or for ${TOR_WAIT_TIMEOUT_MS / 60000} minutes.

options:
  --tor                    send over a Tor onion service (the only mode so far)
${TOR_OPTIONS_USAGE}
  -v, --verbose            show the Tor client's own log lines
  -h, --help
`;

export async function send(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...TOR_OPTIONS,
      tor: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.tor) {
    throw new UsageError('Choose a mode: --tor is the only one so far');
  }
  if (positionals.length !== 1) {
    throw new UsageError('Give exactly one file to send');
  }
  const torOptions = torOptionsFrom(values);
  routeDiagnostics(values.verbose);
  const say = (line: string) => process.stderr.write(`${line}\n`);

  const content = await openFileSource(positionals[0]);
  const fileMetadata = {
    fileName: content.name,
    fileSize: content.estimatedSize,
    mimeType: content.type,
  };
  if (fileMetadata.fileSize > TOR_MAX_TRANSFER_BYTES) {
    throw new Error(
      `The Tor transport carries at most ${formatFileSize(TOR_MAX_TRANSFER_BYTES)}; ${content.name} is ${formatFileSize(fileMetadata.fileSize)}`,
    );
  }
  if (content.projectedWireBytes > TOR_MAX_WIRE_BYTES) {
    throw new Error(
      `${content.name} needs up to ${formatFileSize(content.projectedWireBytes)} on the wire, over the ${formatFileSize(TOR_MAX_WIRE_BYTES)} the Tor transport allows`,
    );
  }
  if (fileMetadata.fileSize > TOR_SUGGESTED_MAX_BYTES) {
    say(
      `${content.name} is ${formatFileSize(fileMetadata.fileSize)}. Throughput over a circuit is unpredictable, and a transfer that drops starts over.`,
    );
  }

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

  const progress = createProgressLine('Sending');
  let lastMessage = '';
  const setState = (state: TransferState) => {
    if (state.status === 'transferring' && state.progress) {
      progress.update(state.progress.current, state.progress.total);
      return;
    }
    if (state.message && state.message !== lastMessage) {
      progress.done();
      say(state.message);
      lastMessage = state.message;
    }
  };

  try {
    client = await bootstrapTor({
      ...torOptions,
      verbose: values.verbose,
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
    process.stdout.write(
      `address: ${formatOnionAddress(service.onionAddress, TOR_DEFAULT_PORT)}\npassword: ${password}\n`,
    );
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
    progress.done();
    say(`Sent ${content.name}`);
    return 0;
  } catch (error) {
    progress.done();
    if (interrupted !== null) return interrupted;
    throw error;
  } finally {
    uninstall();
    await teardown();
  }
}
