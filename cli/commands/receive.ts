import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AppendSink } from '@/lib/append-sink';
import { isValidPin } from '@/lib/crypto';
import { formatFileSize } from '@/lib/file-utils';
import { TorFramedStream } from '@/lib/tor/framing';
import {
  runTorClientHandshake,
  sendCancel,
  sendReady,
} from '@/lib/tor/handshake';
import { parseOnionAddress } from '@/lib/tor/onion-address';
import { receiveFileOverTor, TOR_MAX_TRANSFER_BYTES } from '@/lib/tor/transfer';
import type { WebtorClient } from '@/lib/tor/webtor-api';
import { routeDiagnostics } from '../diagnostics';
import { onInterrupt } from '../interrupt';
import { createProgressLine } from '../progress';
import { readSecret } from '../secret';
import {
  bootstrapTor,
  closeTor,
  TOR_OPTIONS,
  TOR_OPTIONS_USAGE,
  torOptionsFrom,
} from '../tor/bootstrap';
import { createFileSink, safeFileName } from '../transfer/files';
import { UsageError } from '../usage';

/**
 * `ptransfer receive --onion <address>`: connect to the onion service a
 * sender published and take its file, given the address and the one-time
 * password the sender showed. The counterpart of the tab's `useTorReceive`.
 *
 * The password comes from standard input, never from a flag: a flag would
 * leave it in shell history and in the process list. The file lands in the
 * current directory under the name the sender gave it, and nothing is ever
 * overwritten.
 */

const USAGE = `usage: ptransfer receive --onion <address> [options]

Connect to the onion service a sender published and receive its file into
the current directory, under the name the sender gave it. The one-time
password is read from standard input: typed at a prompt, or piped in.

options:
  --onion <host.onion>     the address the sender showed; a :<port> is
                           accepted and wins over the default
${TOR_OPTIONS_USAGE}
  -v, --verbose            show the Tor client's own log lines
  -h, --help
`;

export async function receive(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...TOR_OPTIONS,
      onion: { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.onion) {
    throw new UsageError('Give the onion address with --onion');
  }
  // Both inputs are checked before the bootstrap, which otherwise spends
  // seconds building circuits only to reject them afterwards.
  const parsed = parseOnionAddress(values.onion);
  if (!parsed) {
    throw new UsageError(
      `${values.onion} is not a valid onion address; check for typos`,
    );
  }
  const torOptions = torOptionsFrom(values);
  routeDiagnostics(values.verbose);
  const password = await readSecret('Password: ');
  if (!isValidPin(password)) {
    throw new UsageError('That is not a valid password; check for typos');
  }
  const say = (line: string) => process.stderr.write(`${line}\n`);

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
  const progress = createProgressLine('Receiving');

  try {
    client = await bootstrapTor({
      ...torOptions,
      verbose: values.verbose,
      say,
    });
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
    const destination = resolve(safeFileName(metadata.fileName));
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
        onProgress: (current, total) => progress.update(current, total),
      },
    );
    progress.done();
    // The file is whole: hanging up is the receiver's only word.
    await framed.close();
    say(`Saved ${formatFileSize(payload.size)} to ${destination}`);
    process.stdout.write(`${destination}\n`);
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
