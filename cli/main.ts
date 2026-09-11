import { receive } from './commands/receive';
import { send } from './commands/send';
import { torTest } from './commands/tor-test';
import { routeDiagnostics } from './diagnostics';
import { INTERRUPTED_STATUS, InterruptedError } from './interrupt';
import { UsageError } from './usage';

/**
 * The pTransfer command line, on Bun.
 *
 * It runs the web app's own `src/lib` — the same protocol code, the same
 * Tor client — so a change there is a change here by construction. What it
 * adds is the platform seam a process has and a page does not: files, a
 * cache directory, plain HTTP to the Tor directory authorities.
 *
 * It is a Unix program — Linux and macOS — and leans on that: signals,
 * atomic rename, the XDG cache directory, `/` as the only path separator.
 * Windows is refused up front rather than half-supported.
 *
 *   bun run cli <command> [options]
 */

const USAGE = `usage: ptransfer <command> [options]

commands:
  send       publish an onion service that serves files and folders
  receive    take what an onion service is serving
  tor-test   bootstrap Tor, publish an onion service, and connect back to it

Run a command with --help for its options.
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  send,
  receive,
  'tor-test': torTest,
};

async function main(argv: string[]): Promise<number> {
  if (process.platform === 'win32') {
    process.stderr.write(
      'The pTransfer CLI runs on Linux and macOS; on Windows, use WSL or the web app.\n',
    );
    return 1;
  }
  // Quiet until a command has read its own --verbose.
  routeDiagnostics(false);
  const [command, ...rest] = argv;
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const run = COMMANDS[command];
  if (!run) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  return run(rest);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof InterruptedError) process.exit(INTERRUPTED_STATUS);
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
