import { parseArgs } from 'node:util';
import { parseOnionAddress } from '@/lib/tor/onion-address';
import { defaultCacheDir } from '../cache-dir';
import { receiveByCode } from '../code/receive';
import { routeDiagnostics } from '../diagnostics';
import {
  TOR_OPTIONS,
  TOR_OPTIONS_USAGE,
  torOptionsFrom,
} from '../tor/bootstrap';
import { destinationFolder } from '../transfer/files';
import { receiveOverTor } from '../transfer/tor-receive';
import { createLinePresenter } from '../ui/line';
import { UsageError } from '../usage';

/**
 * `ptransfer receive (--code | --onion <address>)`: take what a sender is
 * sending, in either of the modes a terminal can carry.
 *
 * - `--code` is Code Exchange (`../code/receive.ts`): the sender's code in on
 *   standard input, a response out for the sender to take back.
 * - `--onion` connects to the onion service a sender published and takes its
 *   file, given the address and the one-time password the sender showed —
 *   the counterpart of the tab's `useTorReceive`.
 *
 * A code or a password comes from standard input, never from a flag: a flag
 * would leave it in shell history and in the process list. The file lands in
 * the folder `--out` names, or the current directory, under the name the
 * sender gave it, and nothing is ever overwritten.
 */

const USAGE = `usage: ptransfer receive --code [options]
       ptransfer receive --onion <address> [options]

Receive a file into the current directory, or the folder --out names, under
the name the sender gave it; several files or a folder arrive as one ZIP.

--code reads the code the sender gave — from the web app or ptransfer send
--code — from standard input, and prints a response for the sender to paste
back. The file then comes over a direct connection, or, when none opens,
through the fallback the code names.

--onion connects to the onion service a sender published. The one-time
password is read from standard input: typed at a prompt, or piped in.

options:
  --code                   take a code from the sender and give back a response
  --onion <host.onion>     the address the sender showed; a :<port> is
                           accepted and wins over the default
  -o, --out <folder>       save into this folder, which must exist, instead
                           of the current directory
  --simulate-no-direct     with --code, for testing: answer with no network
                           routes, so the file goes through the fallback the
                           code names
${TOR_OPTIONS_USAGE}
                           (with --code, used when the code asks for the
                           anonymous fallback)
  -v, --verbose            show diagnostics and the Tor client's own log lines
  -h, --help
`;

export async function receive(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...TOR_OPTIONS,
      code: { type: 'boolean', default: false },
      onion: { type: 'string' },
      'simulate-no-direct': { type: 'boolean', default: false },
      out: { type: 'string', short: 'o' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.code === Boolean(values.onion)) {
    throw new UsageError('Choose one mode: --code, or --onion <address>');
  }
  if (values['simulate-no-direct'] && !values.code) {
    throw new UsageError('--simulate-no-direct goes with --code');
  }
  // Every input is checked before the bootstrap, which otherwise spends
  // seconds building circuits only to reject them afterwards.
  const parsed = values.onion ? parseOnionAddress(values.onion) : null;
  if (values.onion && !parsed) {
    throw new UsageError(
      `${values.onion} is not a valid onion address; check for typos`,
    );
  }
  let folder: string;
  try {
    folder = await destinationFolder(values.out ?? '.');
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const torOptions = torOptionsFrom(values);
  routeDiagnostics(values.verbose);
  const presenter = createLinePresenter('Receiving');
  if (!parsed) {
    return await receiveByCode({
      folder,
      simulateNoDirect: values['simulate-no-direct'],
      torOptions,
      cacheDir: torOptions.cacheDir ?? defaultCacheDir(),
      verbose: values.verbose,
      presenter,
    });
  }
  return await receiveOverTor({
    parsed,
    folder,
    torOptions,
    verbose: values.verbose,
    presenter,
  });
}
