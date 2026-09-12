import { parseArgs } from 'node:util';
import { formatFileSize } from '@/lib/file-utils';
import { TOR_WAIT_TIMEOUT_MS } from '@/lib/tor/serve';
import { defaultCacheDir } from '../cache-dir';
import { sendByCode } from '../code/send';
import { routeDiagnostics } from '../diagnostics';
import {
  TOR_OPTIONS,
  TOR_OPTIONS_USAGE,
  torOptionsFrom,
} from '../tor/bootstrap';
import { openSelection } from '../transfer/selection';
import { sendOverTor } from '../transfer/tor-send';
import { createLinePresenter } from '../ui/line';
import { UsageError } from '../usage';

/**
 * `ptransfer send (--code | --tor) <path>...`: send files and folders the way
 * the tab's send tab does, in either of the modes a terminal can carry.
 *
 * - `--code` is Code Exchange (`../code/send.ts`): a code out, the receiver's
 *   response back in, then a direct connection, or the fallback the code
 *   names when none opens.
 * - `--tor` publishes an ephemeral v3 onion service and prints the address
 *   and one-time password the receiver needs — the counterpart of the tab's
 *   `useTorSend`: the same accept loop, the same bounds.
 *
 * Either way one file goes as itself and anything more as one ZIP. What the
 * receiver needs goes to standard output, one line each, so a script can take
 * it; everything else goes to standard error.
 */

const USAGE = `usage: ptransfer send --code <path>... [options]
       ptransfer send --tor <path>... [options]

Send files and folders. One file is sent as itself; several, or a folder, go
as one ZIP that keeps each folder's structure under its name.

--code prints a code for the receiver to paste into the web app or into
ptransfer receive --code, then reads the response they give back from standard
input. The file then goes over a direct connection; when none opens, through
public Nostr relays, or with --anonymous through Tor, for files up to
100 MiB. The code is good for an hour.

--tor publishes an onion service and prints the address and the one-time
password the receiver needs. The service answers until a receiver takes the
transfer, or for ${TOR_WAIT_TIMEOUT_MS / 60000} minutes.

options:
  --code                   hand the receiver a code and take back theirs
  --tor                    send over a Tor onion service
  --anonymous              with --code: relay a file that finds no direct
                           route through Tor rather than public Nostr relays;
                           the Tor options below say how to reach it
${TOR_OPTIONS_USAGE}
  -v, --verbose            show diagnostics and the Tor client's own log lines
  -h, --help
`;

/** How many left-out paths are named before the rest are only counted. */
const SKIPPED_SHOWN = 5;

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export async function send(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...TOR_OPTIONS,
      code: { type: 'boolean', default: false },
      tor: { type: 'boolean', default: false },
      anonymous: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.code === values.tor) {
    throw new UsageError('Choose one mode: --code or --tor');
  }
  if (values.anonymous && !values.code) {
    throw new UsageError('--anonymous goes with --code');
  }
  if (positionals.length === 0) {
    throw new UsageError('Give at least one file or folder to send');
  }
  const torOptions = torOptionsFrom(values);
  routeDiagnostics(values.verbose);
  const presenter = createLinePresenter('Sending');
  const say = (line: string) => presenter.say(line);

  const {
    source: content,
    fileCount,
    skipped,
  } = await openSelection(positionals);
  if (skipped.length > 0) {
    const shown = skipped.slice(0, SKIPPED_SHOWN);
    const more = skipped.length - shown.length;
    say(
      `Leaving out ${count(skipped.length, 'symbolic link or special file', 'symbolic links or special files')}, which the ZIP does not carry:`,
    );
    for (const path of shown) say(`  ${path}`);
    if (more > 0) say(`  and ${more} more`);
  }
  // Only the multiple file/folder flow is precompressed: it is a ZIP.
  if (content.precompressed) {
    say(
      `Sending ${count(fileCount, 'file', 'files')} (${formatFileSize(content.estimatedSize)}) as ${content.name}`,
    );
  }
  if (values.code) {
    return await sendByCode({
      content,
      anonymous: values.anonymous,
      torOptions,
      cacheDir: torOptions.cacheDir ?? defaultCacheDir(),
      verbose: values.verbose,
      presenter,
    });
  }
  return await sendOverTor({
    content,
    torOptions,
    verbose: values.verbose,
    presenter,
  });
}
